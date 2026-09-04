//! Test-provider native input. Events stay inside this application's own NSWindow.
//! No DOM events, global event taps, accessibility injection, cursor movement, or foreign
//! windows are used.

use objc2::MainThreadOnly;
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSProcessInfo, NSRect, NSSize, NSString};
use objc2_web_kit::WKWebView;
use tauri::Runtime;
use tokio::sync::oneshot;

use super::macos::MacOSExecutor;
use super::{ModifierState, PlatformExecutor, PointerEventType};
use crate::server::response::WebDriverErrorResponse;

#[derive(Clone, Copy)]
pub(super) enum NativeInput {
    Pointer {
        kind: PointerEventType,
        x: i32,
        y: i32,
        width: f64,
        height: f64,
    },
    Key {
        down: bool,
        key: NativeKey,
        modifiers: ModifierState,
    },
}

#[derive(Clone, Copy)]
pub(super) struct NativeKey {
    character: char,
    code: u16,
    modifier: bool,
}

fn invalid(message: &str) -> WebDriverErrorResponse {
    WebDriverErrorResponse::invalid_argument(message)
}

pub(super) fn native_key(value: &str) -> Result<NativeKey, WebDriverErrorResponse> {
    let mapped = match value {
        "\u{E003}" => ('\u{7f}', 51, false),
        "\u{E004}" => ('\t', 48, false),
        "\u{E006}" | "\u{E007}" | "\r" | "\n" => ('\r', 36, false),
        "\u{E008}" => ('\0', 56, true),
        "\u{E009}" => ('\0', 59, true),
        "\u{E00A}" => ('\0', 58, true),
        "\u{E00C}" => ('\u{1b}', 53, false),
        "\u{E00D}" | " " => (' ', 49, false),
        "\u{E00E}" => ('\u{F72C}', 116, false),
        "\u{E00F}" => ('\u{F72D}', 121, false),
        "\u{E010}" => ('\u{F72B}', 119, false),
        "\u{E011}" => ('\u{F729}', 115, false),
        "\u{E012}" => ('\u{F702}', 123, false),
        "\u{E013}" => ('\u{F700}', 126, false),
        "\u{E014}" => ('\u{F703}', 124, false),
        "\u{E015}" => ('\u{F701}', 125, false),
        "\u{E017}" => ('\u{F728}', 117, false),
        "\u{E03D}" => ('\0', 55, true),
        _ => {
            let mut characters = value.chars();
            let character = characters
                .next()
                .ok_or_else(|| invalid("native key is empty"))?;
            if characters.next().is_some()
                || character.is_control()
                || ('\u{E000}'..='\u{E05D}').contains(&character)
            {
                return Err(invalid(
                    "native key must be one supported WebDriver key or printable scalar",
                ));
            }
            // AppKit receives the actual Unicode characters. A hardware layout is not guessed.
            (character, 0, false)
        }
    };
    Ok(NativeKey {
        character: mapped.0,
        code: mapped.1,
        modifier: mapped.2,
    })
}

fn flags(modifiers: ModifierState) -> NSEventModifierFlags {
    let mut result = NSEventModifierFlags::empty();
    if modifiers.shift {
        result |= NSEventModifierFlags::Shift;
    }
    if modifiers.ctrl {
        result |= NSEventModifierFlags::Control;
    }
    if modifiers.alt {
        result |= NSEventModifierFlags::Option;
    }
    if modifiers.meta {
        result |= NSEventModifierFlags::Command;
    }
    result
}

fn require_native_focus(active: bool, key_window: bool) -> Result<(), WebDriverErrorResponse> {
    if !active || !key_window {
        return Err(invalid(
            "native input requires the active application's focused session window",
        ));
    }
    Ok(())
}

/// Map the CSS viewport into the unobscured native view, preserving native view orientation.
fn pointer_in_view(
    bounds: NSRect,
    content_layout: Option<NSRect>,
    flipped: bool,
    viewport: NSSize,
    point: NSPoint,
) -> Result<NSPoint, WebDriverErrorResponse> {
    if !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x >= viewport.width
        || point.y >= viewport.height
    {
        return Err(invalid(
            "native pointer is outside the current WebView viewport",
        ));
    }
    let valid_rect = |rect: NSRect| {
        rect.origin.x.is_finite()
            && rect.origin.y.is_finite()
            && rect.size.width.is_finite()
            && rect.size.height.is_finite()
            && rect.size.width > 0.0
            && rect.size.height > 0.0
            && (rect.origin.x + rect.size.width).is_finite()
            && (rect.origin.y + rect.size.height).is_finite()
    };
    if !valid_rect(bounds) {
        return Err(invalid("native WebView has no finite positive bounds"));
    }
    let top_inset = match content_layout {
        Some(layout) => {
            if !valid_rect(layout) {
                return Err(invalid(
                    "native window has no finite positive content layout",
                ));
            }
            let inset = if flipped {
                layout.origin.y - bounds.origin.y
            } else {
                bounds.origin.y + bounds.size.height - (layout.origin.y + layout.size.height)
            };
            inset.max(0.0)
        }
        None => 0.0,
    };
    let native_height = bounds.size.height - top_inset;
    if !native_height.is_finite() || native_height <= 0.0 {
        return Err(invalid("native WebView viewport is fully obscured"));
    }
    let local_x = (point.x / viewport.width) * bounds.size.width;
    let local_y = (point.y / viewport.height) * native_height;
    Ok(NSPoint::new(
        bounds.origin.x + local_x,
        bounds.origin.y
            + if flipped {
                top_inset + local_y
            } else {
                native_height - local_y
            },
    ))
}

/// NSEvent requires window coordinates, not CSS or screen coordinates. In Tauri's default
/// full-size content view, WebKit excludes the opaque titlebar from the DOM viewport. Match
/// WebKit's automatic top-inset conditions and derive its extent through NSView conversion.
fn pointer_location(
    view: &WKWebView,
    window: &NSWindow,
    x: i32,
    y: i32,
    width: f64,
    height: f64,
) -> Result<NSPoint, WebDriverErrorResponse> {
    window.updateConstraintsIfNeeded();
    let bounds = view.bounds();
    let content_layout = (window
        .styleMask()
        .contains(NSWindowStyleMask::FullSizeContentView)
        && !window.titlebarAppearsTransparent()
        && view.enclosingScrollView().is_none())
    .then(|| view.convertRect_fromView(window.contentLayoutRect(), None));
    let flipped = view.isFlipped();
    let point = pointer_in_view(
        bounds,
        content_layout,
        flipped,
        NSSize::new(width, height),
        NSPoint::new(f64::from(x), f64::from(y)),
    )?;
    let location = view.convertPoint_toView(point, None);
    if !location.x.is_finite() || !location.y.is_finite() {
        return Err(invalid("native pointer conversion is not finite"));
    }
    // One bounded geometry record per requested event makes native hit-test failures diagnosable.
    // The provider does not install a tracing subscriber. Use the runner's captured stderr.
    eprintln!(
        "[INFO] [native-input] window={} css=({x},{y}) viewport=({width},{height}) \
         bounds={bounds:?} content_layout={content_layout:?} flipped={flipped} \
         view_point={point:?} window_point={location:?}",
        window.windowNumber(),
    );
    Ok(location)
}

fn deliver(
    view: &WKWebView,
    window: &NSWindow,
    input: NativeInput,
) -> Result<(), WebDriverErrorResponse> {
    let active = NSApplication::sharedApplication(view.mtm()).isActive();
    let key_window = window.isKeyWindow();
    let action = match input {
        NativeInput::Pointer {
            kind: PointerEventType::Move,
            ..
        } => "pointer_move",
        NativeInput::Pointer {
            kind: PointerEventType::Down,
            ..
        } => "pointer_down",
        NativeInput::Pointer {
            kind: PointerEventType::Up,
            ..
        } => "pointer_up",
        NativeInput::Pointer {
            kind: PointerEventType::Click,
            ..
        } => "pointer_click",
        NativeInput::Key { down: true, .. } => "key_down",
        NativeInput::Key { down: false, .. } => "key_up",
    };
    eprintln!(
        "[INFO] [native-input] window={} action={action} active={active} key={key_window}",
        window.windowNumber(),
    );
    // Focus is established by the session's native window lifecycle. Never reactivate in the
    // middle of an input sequence: AppKit activation is asynchronous and can swallow mouse-down.
    require_native_focus(active, key_window)?;
    let timestamp = NSProcessInfo::processInfo().systemUptime();
    let event = match input {
        NativeInput::Pointer { kind, x, y, width, height } => {
            let location = pointer_location(view, window, x, y, width, height)?;
            let event_type = match kind {
                PointerEventType::Move => NSEventType::MouseMoved,
                PointerEventType::Down => NSEventType::LeftMouseDown,
                PointerEventType::Up => NSEventType::LeftMouseUp,
                PointerEventType::Click => {
                    return Err(invalid("native clicks must use a down/up sequence"));
                }
            };
            window.setAcceptsMouseMovedEvents(true);
            NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                event_type, location, NSEventModifierFlags::empty(), timestamp,
                window.windowNumber(), None, 0,
                if matches!(kind, PointerEventType::Move) { 0 } else { 1 },
                if matches!(kind, PointerEventType::Down) { 1.0 } else { 0.0 },
            )
        }
        NativeInput::Key { down, key, modifiers } => {
            let characters = if key.modifier { String::new() } else { key.character.to_string() };
            let text = NSString::from_str(&characters);
            NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                if key.modifier { NSEventType::FlagsChanged }
                else if down { NSEventType::KeyDown } else { NSEventType::KeyUp },
                NSPoint::new(0.0, 0.0), flags(modifiers), timestamp, window.windowNumber(),
                None, &text, &text, false, key.code,
            )
        }
    }.ok_or_else(|| WebDriverErrorResponse::unknown_error("AppKit rejected native event creation"))?;
    if matches!(
        input,
        NativeInput::Key {
            down: true,
            modifiers: ModifierState { meta: true, .. },
            ..
        }
    ) && view.performKeyEquivalent(&event)
    {
        // A native editing shortcut (e.g. select-all) belongs to this same WKWebView's responder.
        // Do not route it through application menus or send it to another window.
        return Ok(());
    }
    // NSWindow is obtained from this exact WKWebView, not from a caller-supplied OS handle.
    // Sending through the native window keeps normal AppKit/WebKit hit testing and responder routing.
    window.sendEvent(&event);
    Ok(())
}

impl<R: Runtime + 'static> MacOSExecutor<R> {
    pub(super) async fn native_input(
        &self,
        input: NativeInput,
    ) -> Result<(), WebDriverErrorResponse> {
        if !self.frame_context.is_empty() {
            return Err(WebDriverErrorResponse::unsupported_operation(
                "native input supports the top-level WebView only",
            ));
        }
        let (tx, rx) = oneshot::channel();
        self.window()
            .with_webview(move |platform| {
                // Tauri runs this closure on the UI thread, and owns the pointer for its duration.
                let result = unsafe {
                    let view: &WKWebView = &*platform.inner().cast();
                    match view.window() {
                        Some(window) => deliver(view, &window, input),
                        None => Err(WebDriverErrorResponse::no_such_window()),
                    }
                };
                let _ = tx.send(result);
            })
            .map_err(|error| WebDriverErrorResponse::unknown_error(&error.to_string()))?;
        match tokio::time::timeout(
            std::time::Duration::from_millis(self.script_timeout_ms()),
            rx,
        )
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error(
                "native input UI channel closed",
            )),
            Err(_) => Err(WebDriverErrorResponse::script_timeout()),
        }
    }
}

#[cfg(test)]
mod native_input_tests {
    use super::{native_key, pointer_in_view, require_native_focus};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    #[test]
    fn rejects_inputs_until_both_application_and_session_window_have_focus() {
        assert!(require_native_focus(true, true).is_ok());
        for (active, key_window) in [(false, true), (true, false), (false, false)] {
            assert!(require_native_focus(active, key_window).is_err());
        }
    }

    #[test]
    fn maps_titlebar_inset_in_both_native_view_orientations() {
        let bounds = NSRect::new(NSPoint::new(10.0, 20.0), NSSize::new(640.0, 520.0));
        let viewport = NSSize::new(640.0, 480.0);
        let point = NSPoint::new(98.0, 34.0);
        let flipped_layout = NSRect::new(NSPoint::new(10.0, 60.0), viewport);
        assert_eq!(
            pointer_in_view(bounds, Some(flipped_layout), true, viewport, point).unwrap(),
            NSPoint::new(108.0, 94.0)
        );
        let unflipped_layout = NSRect::new(bounds.origin, viewport);
        assert_eq!(
            pointer_in_view(bounds, Some(unflipped_layout), false, viewport, point).unwrap(),
            NSPoint::new(108.0, 466.0)
        );
    }

    #[test]
    fn scales_only_unobscured_height_and_does_not_invent_an_overlay_inset() {
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(640.0, 520.0));
        let layout = NSRect::new(NSPoint::new(0.0, 40.0), NSSize::new(640.0, 480.0));
        let viewport = NSSize::new(320.0, 240.0);
        assert_eq!(
            pointer_in_view(
                bounds,
                Some(layout),
                true,
                viewport,
                NSPoint::new(100.0, 120.0)
            )
            .unwrap(),
            NSPoint::new(200.0, 280.0)
        );
        assert_eq!(
            pointer_in_view(
                bounds,
                Some(layout),
                true,
                viewport,
                NSPoint::new(0.0, 239.0)
            )
            .unwrap(),
            NSPoint::new(0.0, 518.0)
        );
        assert_eq!(
            pointer_in_view(bounds, None, true, viewport, NSPoint::new(100.0, 120.0)).unwrap(),
            NSPoint::new(200.0, 260.0)
        );
    }

    #[test]
    fn rejects_invalid_pointer_geometry_and_fully_obscured_viewports() {
        let size = NSSize::new(640.0, 480.0);
        let origin = NSPoint::new(0.0, 0.0);
        let bounds = NSRect::new(origin, size);
        for point in [
            NSPoint::new(-1.0, 0.0),
            NSPoint::new(640.0, 0.0),
            NSPoint::new(0.0, 480.0),
            NSPoint::new(f64::NAN, 0.0),
        ] {
            assert!(pointer_in_view(bounds, None, true, size, point).is_err());
        }
        for viewport in [NSSize::new(0.0, 480.0), NSSize::new(640.0, f64::INFINITY)] {
            assert!(pointer_in_view(bounds, None, true, viewport, origin).is_err());
        }
        for invalid_bounds in [
            NSRect::new(NSPoint::new(f64::NAN, 0.0), size),
            NSRect::new(origin, NSSize::new(640.0, 0.0)),
        ] {
            assert!(pointer_in_view(invalid_bounds, None, true, size, origin).is_err());
        }
        let obscured = NSRect::new(NSPoint::new(0.0, 480.0), size);
        assert!(pointer_in_view(bounds, Some(obscured), true, size, origin).is_err());
        let invalid_layout = NSRect::new(origin, NSSize::new(f64::NAN, 480.0));
        assert!(pointer_in_view(bounds, Some(invalid_layout), true, size, origin).is_err());
    }

    #[test]
    fn preserves_unicode_and_maps_native_navigation_keys() {
        let unicode = native_key("蛇").unwrap();
        assert_eq!(unicode.character, '蛇');
        let enter = native_key("\u{E007}").unwrap();
        assert_eq!((enter.character, enter.code), ('\r', 36));
        let page_up = native_key("\u{E00E}").unwrap();
        assert_eq!((page_up.character, page_up.code), ('\u{F72C}', 116));
    }

    #[test]
    fn rejects_empty_multiscalar_control_and_unknown_webdriver_keys() {
        for value in ["", "ab", "\0", "\u{E001}"] {
            assert!(
                native_key(value).is_err(),
                "unexpected acceptance of {value:?}"
            );
        }
        assert!(native_key("\u{E03D}").unwrap().modifier);
    }
}
