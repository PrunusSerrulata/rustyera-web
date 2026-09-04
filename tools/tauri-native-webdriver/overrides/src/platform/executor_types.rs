use serde::{Deserialize, Serialize};

/// Element bounding rectangle
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Window rectangle (position and size)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowRect {
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Frame identifier for switching frames
#[derive(Debug, Clone)]
pub enum FrameId {
    /// Frame by index
    Index(u32),
    /// Frame by element reference (`js_var`)
    Element(String),
}

/// Pointer event type
#[derive(Debug, Clone, Copy)]
pub enum PointerEventType {
    Down,
    Up,
    Move,
    Click,
}

/// Cookie data
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, rename = "httpOnly")]
    pub http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiry: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sameSite")]
    pub same_site: Option<String>,
}

/// Print options for PDF generation
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrintOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "pageWidth")]
    pub page_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "pageHeight")]
    pub page_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "marginTop")]
    pub margin_top: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "marginBottom")]
    pub margin_bottom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "marginLeft")]
    pub margin_left: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "marginRight")]
    pub margin_right: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "shrinkToFit")]
    pub shrink_to_fit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "pageRanges")]
    pub page_ranges: Option<Vec<String>>,
}

/// Tracks the state of modifier keys during action sequences
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_excessive_bools)]
pub struct ModifierState {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

impl ModifierState {
    /// Update modifier state when a key is pressed or released
    pub fn update(&mut self, key: &str, is_down: bool) {
        match key {
            "\u{E009}" => self.ctrl = is_down,  // Control
            "\u{E008}" => self.shift = is_down, // Shift
            "\u{E00A}" => self.alt = is_down,   // Alt
            "\u{E03D}" => self.meta = is_down,  // Meta
            _ => {}
        }
    }
}
