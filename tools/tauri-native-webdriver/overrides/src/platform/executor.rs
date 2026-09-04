use async_trait::async_trait;
use serde_json::Value;
use tauri::{Runtime, WebviewWindow};

#[cfg(desktop)]
use tauri::{PhysicalPosition, PhysicalSize};

use tauri::Manager;

use crate::platform::alert_state::{AlertStateManager, AlertType};
use crate::server::response::WebDriverErrorResponse;

#[path = "executor_support.rs"]
mod executor_support;
#[path = "executor_types.rs"]
mod executor_types;

pub use executor_support::wrap_script_for_frame_context;
use executor_support::{
    extract_bool_value, extract_script_result_from_inner, extract_string_value,
    extract_usize_value, extract_value, tauri_cookie_to_webdriver, webdriver_cookie_to_tauri,
};
pub use executor_types::{
    Cookie, ElementRect, FrameId, ModifierState, PointerEventType, PrintOptions, WindowRect,
};

/// Platform-agnostic trait for `WebView` operations.
/// Each platform (macOS, Windows, Linux) implements this trait.
#[async_trait]
#[allow(clippy::too_many_lines)]
pub trait PlatformExecutor<R: Runtime>: Send + Sync {
    // =========================================================================
    // Window Access
    // =========================================================================

    /// Get a reference to the underlying window
    fn window(&self) -> &WebviewWindow<R>;

    /// Get the script timeout in milliseconds
    fn script_timeout_ms(&self) -> u64;

    // =========================================================================
    // Core JavaScript Execution
    // =========================================================================

    /// Execute JavaScript and return the result as JSON
    async fn evaluate_js(&self, script: &str) -> Result<Value, WebDriverErrorResponse>;

    // =========================================================================
    // Navigation
    // =========================================================================

    /// Navigate to a URL
    async fn navigate(&self, url: &str) -> Result<(), WebDriverErrorResponse> {
        let script = format!(
            r"window.location.href = '{}'; null;",
            url.replace('\\', "\\\\").replace('\'', "\\'")
        );
        self.evaluate_js(&script).await?;
        Ok(())
    }

    /// Get current URL
    async fn get_url(&self) -> Result<String, WebDriverErrorResponse> {
        let result = self.evaluate_js("window.location.href").await?;
        extract_string_value(&result)
    }

    /// Get page title
    async fn get_title(&self) -> Result<String, WebDriverErrorResponse> {
        let result = self.evaluate_js("document.title").await?;
        extract_string_value(&result)
    }

    /// Navigate back in history
    async fn go_back(&self) -> Result<(), WebDriverErrorResponse> {
        self.evaluate_js("window.history.back(); null;").await?;
        Ok(())
    }

    /// Navigate forward in history
    async fn go_forward(&self) -> Result<(), WebDriverErrorResponse> {
        self.evaluate_js("window.history.forward(); null;").await?;
        Ok(())
    }

    /// Refresh the current page
    async fn refresh(&self) -> Result<(), WebDriverErrorResponse> {
        self.evaluate_js("window.location.reload(); null;").await?;
        Ok(())
    }

    // =========================================================================
    // Document
    // =========================================================================

    /// Get page source HTML
    async fn get_source(&self) -> Result<String, WebDriverErrorResponse> {
        let result = self
            .evaluate_js("document.documentElement.outerHTML")
            .await?;
        extract_string_value(&result)
    }

    // =========================================================================
    // Element Operations
    // =========================================================================

    /// Find element and store reference in a JavaScript variable
    /// Returns true if element was found
    async fn find_element(
        &self,
        strategy_js: &str,
        js_var: &str,
    ) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = {strategy_js};
                if (el) {{
                    window.{js_var} = el;
                    return true;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Find multiple elements and store count
    /// Returns the number of elements found
    async fn find_elements(
        &self,
        strategy_js: &str,
        js_var_prefix: &str,
    ) -> Result<usize, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var elements = {strategy_js};
                var count = elements.length;
                for (var i = 0; i < count; i++) {{
                    window['{js_var_prefix}' + i] = elements[i];
                }}
                return count;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_usize_value(&result)
    }

    /// Find element from a parent element and store reference
    /// Returns true if element was found
    async fn find_element_from_element(
        &self,
        parent_js_var: &str,
        strategy_js: &str,
        js_var: &str,
    ) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var parent = window.{parent_js_var};
                if (!parent || !parent.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var el = {strategy_js};
                if (el) {{
                    window.{js_var} = el;
                    return true;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Find multiple elements from a parent element
    /// Returns count of elements found, stores as {prefix}0, {prefix}1, etc.
    async fn find_elements_from_element(
        &self,
        parent_js_var: &str,
        strategy_js: &str,
        js_var_prefix: &str,
    ) -> Result<usize, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var parent = window.{parent_js_var};
                if (!parent || !parent.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var elements = {strategy_js};
                var count = elements.length;
                for (var i = 0; i < count; i++) {{
                    window['{js_var_prefix}' + i] = elements[i];
                }}
                return count;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_usize_value(&result)
    }

    /// Get element text content
    async fn get_element_text(&self, js_var: &str) -> Result<String, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                return el.textContent || '';
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_string_value(&result)
    }

    /// Get element tag name (lowercase)
    async fn get_element_tag_name(&self, js_var: &str) -> Result<String, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                return el.tagName.toLowerCase();
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_string_value(&result)
    }

    /// Get element attribute value
    /// Per W3C `WebDriver` spec, certain attributes should return current property values:
    /// - "value" on input/textarea returns current value property
    /// - "checked" on checkbox/radio returns current checked state
    /// - "selected" on option returns current selected state
    async fn get_element_attribute(
        &self,
        js_var: &str,
        name: &str,
    ) -> Result<Option<String>, WebDriverErrorResponse> {
        include!("executor_body_get_element_attribute.rs")
    }

    /// Get element property value
    async fn get_element_property(
        &self,
        js_var: &str,
        name: &str,
    ) -> Result<Value, WebDriverErrorResponse> {
        let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                return el['{escaped_name}'];
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_value(&result)
    }

    /// Get element CSS property value
    async fn get_element_css_value(
        &self,
        js_var: &str,
        property: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        let escaped_prop = property.replace('\\', "\\\\").replace('\'', "\\'");
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                return window.getComputedStyle(el).getPropertyValue('{escaped_prop}');
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_string_value(&result)
    }

    /// Get element bounding rectangle
    async fn get_element_rect(&self, js_var: &str) -> Result<ElementRect, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var rect = el.getBoundingClientRect();
                return {{
                    x: rect.x + window.scrollX,
                    y: rect.y + window.scrollY,
                    width: rect.width,
                    height: rect.height
                }};
            }})()"
        );
        let result = self.evaluate_js(&script).await?;

        if let Some(value) = result.get("value") {
            return Ok(ElementRect {
                x: value.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                y: value.get("y").and_then(Value::as_f64).unwrap_or(0.0),
                width: value.get("width").and_then(Value::as_f64).unwrap_or(0.0),
                height: value.get("height").and_then(Value::as_f64).unwrap_or(0.0),
            });
        }
        Ok(ElementRect::default())
    }

    /// Get an element's in-view center point in **client (viewport)** coordinates,
    /// scrolling it into view first. Unlike [`Executor::get_element_rect`], this
    /// does not add scroll offsets: pointer events dispatch against viewport
    /// coordinates (`clientX`/`clientY`), so the center must be viewport-relative.
    async fn get_element_center(&self, js_var: &str) -> Result<(i32, i32), WebDriverErrorResponse> {
        include!("executor_body_get_element_center.rs")
    }

    /// Check if element is displayed
    async fn is_element_displayed(&self, js_var: &str) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Check if element is enabled
    async fn is_element_enabled(&self, js_var: &str) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                return !el.disabled;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Check if element is selected (for checkboxes, radio buttons, options)
    async fn is_element_selected(&self, js_var: &str) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {{
                    return el.checked;
                }}
                if (el.tagName === 'OPTION') {{
                    return el.selected;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Click on element
    async fn click_element(&self, js_var: &str) -> Result<(), WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                el.scrollIntoView({{ block: 'center', inline: 'center' }});
                el.click();
                // Explicitly focus the element after click - programmatic click()
                // doesn't always trigger focus like a real click would
                if (typeof el.focus === 'function') {{
                    el.focus();
                }}
                return true;
            }})()"
        );
        self.evaluate_js(&script).await?;
        Ok(())
    }

    /// Clear element content (for inputs/textareas)
    async fn clear_element(&self, js_var: &str) -> Result<(), WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                el.focus();
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
                        'value'
                    ).set;
                    nativeInputValueSetter.call(el, '');
                    var inputEvent = new InputEvent('input', {{
                        bubbles: true,
                        cancelable: true,
                        inputType: 'deleteContentBackward'
                    }});
                    el.dispatchEvent(inputEvent);
                    var changeEvent = new Event('change', {{ bubbles: true }});
                    el.dispatchEvent(changeEvent);
                }} else if (el.isContentEditable) {{
                    el.innerHTML = '';
                }}
                return true;
            }})()"
        );
        self.evaluate_js(&script).await?;
        Ok(())
    }

    /// Send keys to element
    async fn send_keys_to_element(
        &self,
        js_var: &str,
        text: &str,
    ) -> Result<(), WebDriverErrorResponse> {
        include!("executor_body_send_keys_to_element.rs")
    }

    /// Get the active (focused) element and store in `js_var`
    /// Returns true if an active element was found
    async fn get_active_element(&self, js_var: &str) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = document.activeElement;
                if (el && el !== document.body) {{
                    window.{js_var} = el;
                    return true;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Get element's computed accessibility role
    async fn get_element_computed_role(
        &self,
        js_var: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        include!("executor_body_get_element_computed_role.rs")
    }

    /// Get element's computed accessibility label
    async fn get_element_computed_label(
        &self,
        js_var: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        include!("executor_body_get_element_computed_label.rs")
    }

    // =========================================================================
    // Shadow DOM
    // =========================================================================

    /// Get element's shadow root and store in `shadow_var`
    /// Returns true if shadow root exists
    async fn get_element_shadow_root(
        &self,
        js_var: &str,
        shadow_var: &str,
    ) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = window.{js_var};
                if (!el || !el.isConnected) {{
                    throw new Error('stale element reference');
                }}
                var shadow = el.shadowRoot;
                if (shadow) {{
                    window.{shadow_var} = shadow;
                    return true;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Find element within a shadow root
    async fn find_element_from_shadow(
        &self,
        shadow_var: &str,
        strategy_js: &str,
        js_var: &str,
    ) -> Result<bool, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var shadow = window.{shadow_var};
                if (!shadow) {{
                    throw new Error('no such shadow root');
                }}
                var el = {strategy_js};
                if (el) {{
                    window.{js_var} = el;
                    return true;
                }}
                return false;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_bool_value(&result)
    }

    /// Find multiple elements within a shadow root
    async fn find_elements_from_shadow(
        &self,
        shadow_var: &str,
        strategy_js: &str,
        js_var_prefix: &str,
    ) -> Result<usize, WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var shadow = window.{shadow_var};
                if (!shadow) {{
                    throw new Error('no such shadow root');
                }}
                var elements = {strategy_js};
                var count = elements.length;
                for (var i = 0; i < count; i++) {{
                    window['{js_var_prefix}' + i] = elements[i];
                }}
                return count;
            }})()"
        );
        let result = self.evaluate_js(&script).await?;
        extract_usize_value(&result)
    }

    // =========================================================================
    // Script Execution
    // =========================================================================

    /// Execute synchronous JavaScript with arguments
    async fn execute_script(
        &self,
        script: &str,
        args: &[Value],
    ) -> Result<Value, WebDriverErrorResponse> {
        include!("executor_body_execute_script.rs")
    }

    /// Execute asynchronous JavaScript with callback.
    ///
    /// Each platform must implement this using native message handlers.
    async fn execute_async_script(
        &self,
        script: &str,
        args: &[Value],
    ) -> Result<Value, WebDriverErrorResponse>;

    // =========================================================================
    // Screenshots
    // =========================================================================

    /// Take screenshot of the page, returns base64-encoded PNG
    async fn take_screenshot(&self) -> Result<String, WebDriverErrorResponse>;

    /// Take screenshot of a specific element, returns base64-encoded PNG
    async fn take_element_screenshot(&self, js_var: &str)
        -> Result<String, WebDriverErrorResponse>;

    // =========================================================================
    // Actions (Keyboard/Pointer)
    // =========================================================================

    /// Dispatch a keyboard event with modifier state
    async fn dispatch_key_event(
        &self,
        key: &str,
        is_down: bool,
        modifiers: &ModifierState,
    ) -> Result<(), WebDriverErrorResponse> {
        include!("executor_body_dispatch_key_event.rs")
    }

    /// Dispatch a regular (non-special) key event with modifier state
    async fn dispatch_regular_key(
        &self,
        key: &str,
        code: &str,
        is_down: bool,
        modifiers: &ModifierState,
    ) -> Result<(), WebDriverErrorResponse> {
        include!("executor_body_dispatch_regular_key.rs")
    }

    /// Dispatch a pointer/mouse event
    async fn dispatch_pointer_event(
        &self,
        event_type: PointerEventType,
        x: i32,
        y: i32,
        button: u32,
    ) -> Result<(), WebDriverErrorResponse> {
        include!("executor_body_dispatch_pointer_event.rs")
    }

    /// Dispatch a scroll/wheel event
    async fn dispatch_scroll_event(
        &self,
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
    ) -> Result<(), WebDriverErrorResponse> {
        let script = format!(
            r"(function() {{
                var el = document.elementFromPoint({x}, {y});
                if (!el) el = document.body;

                var event = new WheelEvent('wheel', {{
                    bubbles: true,
                    cancelable: true,
                    clientX: {x},
                    clientY: {y},
                    deltaX: {delta_x},
                    deltaY: {delta_y},
                    deltaMode: 0
                }});
                el.dispatchEvent(event);

                window.scrollBy({delta_x}, {delta_y});
                return true;
            }})()"
        );

        self.evaluate_js(&script).await?;
        Ok(())
    }

    // =========================================================================
    // Window Management
    // =========================================================================

    /// Get window rectangle (position and size)
    #[cfg(desktop)]
    async fn get_window_rect(&self) -> Result<WindowRect, WebDriverErrorResponse> {
        if let Ok(position) = self.window().outer_position() {
            if let Ok(size) = self.window().outer_size() {
                return Ok(WindowRect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                });
            }
        }
        Ok(WindowRect::default())
    }

    #[cfg(mobile)]
    async fn get_window_rect(&self) -> Result<WindowRect, WebDriverErrorResponse>;

    /// Set window rectangle (position and size)
    #[cfg(desktop)]
    async fn set_window_rect(
        &self,
        rect: WindowRect,
    ) -> Result<WindowRect, WebDriverErrorResponse> {
        // Exit fullscreen/maximized state before setting rect
        // Otherwise the window manager may ignore our size/position request
        if self.window().is_fullscreen().unwrap_or(false) {
            let _ = self.window().set_fullscreen(false);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        if self.window().is_maximized().unwrap_or(false) {
            let _ = self.window().unmaximize();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        let _ = self
            .window()
            .set_position(PhysicalPosition::new(rect.x, rect.y));

        // Calculate chrome/decoration size to set outer size correctly
        // On Windows/Linux, set_size sets inner size, but we want to set outer size
        let (chrome_width, chrome_height) = if let (Ok(outer), Ok(inner)) =
            (self.window().outer_size(), self.window().inner_size())
        {
            (
                outer.width.saturating_sub(inner.width),
                outer.height.saturating_sub(inner.height),
            )
        } else {
            (0, 0)
        };

        // Set inner size = requested outer size - chrome
        let inner_width = rect.width.saturating_sub(chrome_width);
        let inner_height = rect.height.saturating_sub(chrome_height);
        let _ = self
            .window()
            .set_size(PhysicalSize::new(inner_width, inner_height));

        self.get_window_rect().await
    }

    /// Maximize window
    #[cfg(desktop)]
    async fn maximize_window(&self) -> Result<WindowRect, WebDriverErrorResponse> {
        let _ = self.window().maximize();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.get_window_rect().await
    }

    /// Minimize window
    #[cfg(desktop)]
    async fn minimize_window(&self) -> Result<(), WebDriverErrorResponse> {
        let _ = self.window().minimize();
        Ok(())
    }

    /// Set window to fullscreen
    #[cfg(desktop)]
    async fn fullscreen_window(&self) -> Result<WindowRect, WebDriverErrorResponse> {
        let _ = self.window().set_fullscreen(true);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.get_window_rect().await
    }

    /// Set window rectangle (mobile unsupported)
    #[cfg(mobile)]
    async fn set_window_rect(
        &self,
        _rect: WindowRect,
    ) -> Result<WindowRect, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Setting window rect is not supported on mobile platforms",
        ))
    }

    /// Maximize window (mobile unsupported)
    #[cfg(mobile)]
    async fn maximize_window(&self) -> Result<WindowRect, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Maximizing window is not supported on mobile platforms",
        ))
    }

    /// Minimize window (mobile unsupported)
    #[cfg(mobile)]
    async fn minimize_window(&self) -> Result<(), WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Minimizing window is not supported on mobile platforms",
        ))
    }

    /// Set window to fullscreen (mobile unsupported)
    #[cfg(mobile)]
    async fn fullscreen_window(&self) -> Result<WindowRect, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Fullscreen window is not supported on mobile platforms",
        ))
    }

    // =========================================================================
    // Frames
    // =========================================================================

    /// Switch to a frame by ID (index or element reference)
    async fn switch_to_frame(&self, id: FrameId) -> Result<(), WebDriverErrorResponse> {
        match id {
            FrameId::Index(index) => {
                let script = format!(
                    r"(function() {{
                        var frames = document.querySelectorAll('iframe, frame');
                        if ({index} >= frames.length) {{
                            return false;
                        }}
                        return true;
                    }})()"
                );
                let result = self.evaluate_js(&script).await?;
                if result.get("value") == Some(&Value::Bool(false)) {
                    return Err(WebDriverErrorResponse::no_such_frame());
                }
                Ok(())
            }
            FrameId::Element(js_var) => {
                let script = format!(
                    r"(function() {{
                        var el = window.{js_var};
                        if (!el || !el.isConnected) {{
                            throw new Error('stale element reference');
                        }}
                        if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') {{
                            throw new Error('element is not a frame');
                        }}
                        return true;
                    }})()"
                );
                self.evaluate_js(&script).await?;
                Ok(())
            }
        }
    }

    /// Switch to parent frame
    async fn switch_to_parent_frame(&self) -> Result<(), WebDriverErrorResponse> {
        // No-op - frame context is managed by the session, not the executor
        Ok(())
    }

    // =========================================================================
    // Cookies (using Tauri's native cookie APIs)
    // =========================================================================

    /// Get all cookies
    async fn get_all_cookies(&self) -> Result<Vec<Cookie>, WebDriverErrorResponse> {
        self.window()
            .cookies()
            .map(|cookies| cookies.iter().map(tauri_cookie_to_webdriver).collect())
            .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))
    }

    /// Get a specific cookie by name
    async fn get_cookie(&self, name: &str) -> Result<Option<Cookie>, WebDriverErrorResponse> {
        let cookies = self.get_all_cookies().await?;
        Ok(cookies.into_iter().find(|c| c.name == name))
    }

    /// Add a cookie
    async fn add_cookie(&self, mut cookie: Cookie) -> Result<(), WebDriverErrorResponse> {
        // Per WebDriver spec: if no domain is specified, use the current page's domain
        if cookie.domain.is_none() {
            if let Ok(url) = self.window().url() {
                cookie.domain = url.host_str().map(String::from);
            }
        }

        // Default path to "/" if not specified
        if cookie.path.is_none() {
            cookie.path = Some("/".to_string());
        }

        let tauri_cookie = webdriver_cookie_to_tauri(&cookie);
        self.window()
            .set_cookie(tauri_cookie)
            .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))
    }

    /// Delete a cookie by name
    async fn delete_cookie(&self, name: &str) -> Result<(), WebDriverErrorResponse> {
        // Find the cookie first to get its exact domain/path for deletion
        let cookies = self
            .window()
            .cookies()
            .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))?;

        for cookie in cookies {
            if cookie.name() == name {
                self.window()
                    .delete_cookie(cookie)
                    .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))?;
                return Ok(());
            }
        }
        Ok(())
    }

    /// Delete all cookies
    async fn delete_all_cookies(&self) -> Result<(), WebDriverErrorResponse> {
        let cookies = self
            .window()
            .cookies()
            .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))?;

        for cookie in cookies {
            self.window()
                .delete_cookie(cookie)
                .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))?;
        }
        Ok(())
    }

    // =========================================================================
    // Alerts (using per-window alert state)
    // =========================================================================

    /// Dismiss the current alert (cancel)
    async fn dismiss_alert(&self) -> Result<(), WebDriverErrorResponse> {
        let manager = self.window().app_handle().state::<AlertStateManager>();
        let alert_state = manager.get_or_create(self.window().label());
        if alert_state.respond(false, None) {
            Ok(())
        } else {
            Err(WebDriverErrorResponse::no_such_alert())
        }
    }

    /// Accept the current alert (OK)
    async fn accept_alert(&self) -> Result<(), WebDriverErrorResponse> {
        let manager = self.window().app_handle().state::<AlertStateManager>();
        let alert_state = manager.get_or_create(self.window().label());
        // For prompts, use input text if set, otherwise default text
        let prompt_text = alert_state
            .get_prompt_input()
            .or_else(|| alert_state.get_default_text());
        if alert_state.respond(true, prompt_text) {
            Ok(())
        } else {
            Err(WebDriverErrorResponse::no_such_alert())
        }
    }

    /// Get the text of the current alert
    async fn get_alert_text(&self) -> Result<String, WebDriverErrorResponse> {
        let manager = self.window().app_handle().state::<AlertStateManager>();
        let alert_state = manager.get_or_create(self.window().label());
        match alert_state.get_message() {
            Some(msg) => Ok(msg),
            None => Err(WebDriverErrorResponse::no_such_alert()),
        }
    }

    /// Send text to the current alert (for prompts)
    async fn send_alert_text(&self, text: &str) -> Result<(), WebDriverErrorResponse> {
        let manager = self.window().app_handle().state::<AlertStateManager>();
        let alert_state = manager.get_or_create(self.window().label());
        match alert_state.get_alert_type() {
            None => Err(WebDriverErrorResponse::no_such_alert()),
            Some(AlertType::Prompt) => {
                // Store the text for when acceptAlert is called
                if alert_state.set_prompt_input(text.to_string()) {
                    Ok(())
                } else {
                    Err(WebDriverErrorResponse::no_such_alert())
                }
            }
            Some(_) => Err(WebDriverErrorResponse::element_not_interactable(
                "User prompt is not a prompt dialog",
            )),
        }
    }

    // =========================================================================
    // Print
    // =========================================================================

    /// Print page to PDF, returns base64-encoded PDF
    async fn print_page(&self, options: PrintOptions) -> Result<String, WebDriverErrorResponse>;
}
