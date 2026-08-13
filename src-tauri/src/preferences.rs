#[allow(clippy::wildcard_imports)]
use super::*;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preferences {
    pub(super) schema_version: u32,
    pub(super) font_family_override: Option<String>,
    pub(super) font_size_override_px: Option<u8>,
    pub(super) image_scale: f64,
    pub(super) master_volume: f64,
    #[serde(default)]
    pub(super) trust_project_file_metadata: bool,
}

impl Preferences {
    pub(super) fn normalized(mut self) -> Self {
        // Schema 1/2 stored global font controls that the unified project settings UI no longer
        // exposes. Clear those unremovable values so project FontName/FontSize can hot-apply;
        // schema 3 values are deliberate accessibility overrides and remain supported.
        let obsolete_font_overrides = self.schema_version < 3;
        self.schema_version = 4;
        if obsolete_font_overrides {
            self.font_family_override = None;
        }
        self.font_size_override_px = if obsolete_font_overrides {
            None
        } else {
            self.font_size_override_px.map(|value| value.clamp(8, 72))
        };
        self.image_scale = if self.image_scale.is_finite() {
            self.image_scale.clamp(0.25, 4.0)
        } else {
            1.0
        };
        self.master_volume = if self.master_volume.is_finite() {
            self.master_volume.clamp(0.0, 1.0)
        } else {
            1.0
        };
        self
    }
}

#[tauri::command]
pub(super) fn load_preferences(app: AppHandle) -> Result<Preferences, String> {
    let path = preferences_path(&app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)
            .map(Preferences::normalized)
            .map_err(|error| format!("invalid preferences file: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_preferences()),
        Err(error) => Err(format!("cannot read preferences: {error}")),
    }
}

#[tauri::command]
pub(super) fn save_preferences(
    app: AppHandle,
    preferences: Preferences,
) -> Result<Preferences, String> {
    let preferences = preferences.normalized();
    let path = preferences_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "preferences path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create config directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("cannot create temporary preferences file: {error}"))?;
    serde_json::to_writer_pretty(&mut temporary, &preferences)
        .map_err(|error| format!("cannot encode preferences: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("cannot sync preferences: {error}"))?;
    temporary
        .persist(&path)
        .map_err(|error| format!("cannot replace preferences: {}", error.error))?;
    Ok(preferences)
}

pub(super) fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("preferences-v1.json"))
        .map_err(|error| format!("cannot resolve application config directory: {error}"))
}

pub(super) fn default_preferences() -> Preferences {
    Preferences {
        schema_version: 4,
        font_family_override: None,
        font_size_override_px: None,
        image_scale: 1.0,
        master_volume: 1.0,
        trust_project_file_metadata: false,
    }
}
