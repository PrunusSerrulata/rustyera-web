#[allow(clippy::wildcard_imports)]
use super::*;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preferences {
    pub(super) schema_version: u32,
    #[serde(default)]
    pub(super) settings: BTreeMap<String, String>,
    pub(super) font_family_override: Option<String>,
    pub(super) font_size_override_px: Option<u8>,
    pub(super) image_scale: f64,
    pub(super) master_volume: f64,
    #[serde(default)]
    pub(super) trust_project_file_metadata: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPreferences {
    #[serde(default)]
    pub(super) settings: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) image_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) master_volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) trust_project_file_metadata: Option<bool>,
}

impl ProjectPreferences {
    fn normalized(mut self) -> Self {
        self.image_scale = self
            .image_scale
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.25, 4.0));
        self.master_volume = self
            .master_volume
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 1.0));
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPreferenceProfile {
    #[serde(default)]
    settings: BTreeMap<String, String>,
    #[serde(default)]
    client: serde_json::Map<String, Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPreferenceDocument {
    schema_version: u32,
    #[serde(default)]
    profiles: BTreeMap<String, ProjectPreferenceProfile>,
}

impl Default for ProjectPreferenceDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            profiles: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPreferencesLoad {
    preferences: ProjectPreferences,
    writable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct ProjectPreferenceLocation {
    pub(super) path: PathBuf,
    pub(super) project_file: bool,
}

impl Preferences {
    pub(super) fn normalized(mut self) -> Self {
        // Schema 1/2 stored global font controls that the unified project settings UI no longer
        // exposes. Clear those unremovable values so project FontName/FontSize can hot-apply;
        // schema 3 values are deliberate accessibility overrides and remain supported.
        let obsolete_font_overrides = self.schema_version < 3;
        if !obsolete_font_overrides {
            if let Some(value) = self.font_family_override.as_ref()
                && !value.is_empty()
            {
                self.settings
                    .entry("FontName".into())
                    .or_insert_with(|| value.clone());
            }
            if let Some(value) = self.font_size_override_px {
                self.settings
                    .entry("FontSize".into())
                    .or_insert_with(|| value.clamp(8, 72).to_string());
            }
        }
        self.schema_version = 5;
        if obsolete_font_overrides {
            self.font_family_override = None;
        }
        self.font_family_override = None;
        self.font_size_override_px = None;
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
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<ProjectPreferenceDocument>(&bytes) {
            Ok(document) if document.schema_version == 1 => {
                validate_active_profile(&document)
                    .map_err(|error| format!("invalid preferences file: {error}"))?;
                Ok(global_profile_preferences(&document))
            }
            _ => serde_json::from_slice::<Preferences>(&bytes)
                .map(Preferences::normalized)
                .map_err(|error| format!("invalid preferences file: {error}")),
        },
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
    let mut document = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<ProjectPreferenceDocument>(&bytes) {
            Ok(document) if document.schema_version == 1 => {
                validate_active_profile(&document)
                    .map_err(|error| format!("invalid preferences file: {error}"))?;
                document
            }
            _ if serde_json::from_slice::<Preferences>(&bytes).is_ok() => {
                ProjectPreferenceDocument::default()
            }
            _ => return Err("invalid preferences file".into()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ProjectPreferenceDocument::default()
        }
        Err(error) => return Err(format!("cannot read preferences: {error}")),
    };
    document.profiles.insert(
        "tauri".into(),
        profile_from_values(
            preferences.settings.clone(),
            Some(preferences.image_scale),
            Some(preferences.master_volume),
            Some(preferences.trust_project_file_metadata),
        ),
    );
    write_json_atomically(&path, &document, "preferences")?;
    Ok(preferences)
}

#[tauri::command]
pub(super) fn load_project_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectPreferencesLoad, String> {
    let location = state
        .project_preferences
        .lock()
        .map_err(lock_error)?
        .clone()
        .ok_or_else(|| "no project is open".to_owned())?;
    let preference_path = project_preferences_path(&app, &location.path, location.project_file)?;
    match read_project_preference_document(&preference_path) {
        Ok(document) => Ok(ProjectPreferencesLoad {
            preferences: profile_preferences(&document),
            writable: true,
            error: None,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProjectPreferencesLoad {
            preferences: ProjectPreferences::default(),
            writable: true,
            error: None,
        }),
        Err(error) => Ok(ProjectPreferencesLoad {
            preferences: ProjectPreferences::default(),
            writable: false,
            error: Some(format!("cannot read project preferences: {error}")),
        }),
    }
}

#[tauri::command]
pub(super) fn save_project_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    preferences: ProjectPreferences,
) -> Result<ProjectPreferences, String> {
    let location = state
        .project_preferences
        .lock()
        .map_err(lock_error)?
        .clone()
        .ok_or_else(|| "no project is open".to_owned())?;
    let preference_path = project_preferences_path(&app, &location.path, location.project_file)?;
    let mut document = match read_project_preference_document(&preference_path) {
        Ok(document) => document,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ProjectPreferenceDocument::default()
        }
        Err(error) => return Err(format!("cannot read project preferences: {error}")),
    };
    let preferences = preferences.normalized();
    document.profiles.insert(
        "tauri".into(),
        profile_from_values(
            preferences.settings.clone(),
            preferences.image_scale,
            preferences.master_volume,
            preferences.trust_project_file_metadata,
        ),
    );
    write_json_atomically(&preference_path, &document, "project preferences")?;
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
        schema_version: 5,
        settings: BTreeMap::new(),
        font_family_override: None,
        font_size_override_px: None,
        image_scale: 1.0,
        master_volume: 1.0,
        trust_project_file_metadata: false,
    }
}

pub(super) fn effective_source_metadata_trust(
    app: &AppHandle,
    project_path: &Path,
) -> Result<bool, String> {
    let global = load_preferences(app.clone())?.trust_project_file_metadata;
    let path = project_preferences_path(app, project_path, false)?;
    match read_project_preference_document(&path) {
        Ok(document) => Ok(profile_preferences(&document)
            .trust_project_file_metadata
            .unwrap_or(global)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(global),
        Err(error) => Err(format!("cannot read project preferences: {error}")),
    }
}

fn project_preferences_path(
    app: &AppHandle,
    project_path: &Path,
    project_file: bool,
) -> Result<PathBuf, String> {
    if !project_file {
        return Ok(project_path.join(".rustyera/preferences-v1.json"));
    }
    let canonical = project_path.canonicalize().map_err(|error| {
        format!(
            "cannot canonicalize packaged project path {}: {error}",
            project_path.display()
        )
    })?;
    let key = blake3::hash(canonical.to_string_lossy().as_bytes()).to_hex();
    app.path()
        .app_data_dir()
        .map(|directory| {
            directory
                .join("project-preferences")
                .join(key.as_str())
                .join("preferences-v1.json")
        })
        .map_err(|error| format!("cannot resolve application data directory: {error}"))
}

fn read_project_preference_document(path: &Path) -> std::io::Result<ProjectPreferenceDocument> {
    let bytes = fs::read(path)?;
    let document = serde_json::from_slice::<ProjectPreferenceDocument>(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if document.schema_version != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unsupported schema version {}", document.schema_version),
        ));
    }
    validate_active_profile(&document)?;
    Ok(document)
}

fn validate_active_profile(document: &ProjectPreferenceDocument) -> std::io::Result<()> {
    let Some(profile) = document.profiles.get("tauri") else {
        return Ok(());
    };
    if !profile.extra.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "tauri preference profile contains unknown fields",
        ));
    }
    for key in profile.client.keys() {
        if !matches!(
            key.as_str(),
            "imageScale" | "masterVolume" | "trustProjectFileMetadata"
        ) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("tauri client preferences contain unknown field {key}"),
            ));
        }
    }
    validate_optional_number(&profile.client, "imageScale", 0.25, 4.0)?;
    validate_optional_number(&profile.client, "masterVolume", 0.0, 1.0)?;
    if profile
        .client
        .get("trustProjectFileMetadata")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "trustProjectFileMetadata must be a boolean",
        ));
    }
    Ok(())
}

fn validate_optional_number(
    values: &serde_json::Map<String, Value>,
    key: &str,
    minimum: f64,
    maximum: f64,
) -> std::io::Result<()> {
    if let Some(value) = values.get(key) {
        let valid = value
            .as_f64()
            .is_some_and(|value| value.is_finite() && value >= minimum && value <= maximum);
        if !valid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{key} must be a number from {minimum} to {maximum}"),
            ));
        }
    }
    Ok(())
}

fn profile_preferences(document: &ProjectPreferenceDocument) -> ProjectPreferences {
    let Some(profile) = document.profiles.get("tauri") else {
        return ProjectPreferences::default();
    };
    ProjectPreferences {
        settings: profile.settings.clone(),
        image_scale: json_f64(&profile.client, "imageScale"),
        master_volume: json_f64(&profile.client, "masterVolume"),
        trust_project_file_metadata: profile
            .client
            .get("trustProjectFileMetadata")
            .and_then(Value::as_bool),
    }
}

fn global_profile_preferences(document: &ProjectPreferenceDocument) -> Preferences {
    let project = profile_preferences(document);
    Preferences {
        schema_version: 5,
        settings: project.settings,
        font_family_override: None,
        font_size_override_px: None,
        image_scale: project.image_scale.unwrap_or(1.0),
        master_volume: project.master_volume.unwrap_or(1.0),
        trust_project_file_metadata: project.trust_project_file_metadata.unwrap_or(false),
    }
}

fn profile_from_values(
    settings: BTreeMap<String, String>,
    image_scale: Option<f64>,
    master_volume: Option<f64>,
    trust_project_file_metadata: Option<bool>,
) -> ProjectPreferenceProfile {
    let mut client = serde_json::Map::new();
    if let Some(value) = image_scale {
        client.insert("imageScale".into(), Value::from(value));
    }
    if let Some(value) = master_volume {
        client.insert("masterVolume".into(), Value::from(value));
    }
    if let Some(value) = trust_project_file_metadata {
        client.insert("trustProjectFileMetadata".into(), Value::from(value));
    }
    ProjectPreferenceProfile {
        settings,
        client,
        extra: serde_json::Map::new(),
    }
}

fn json_f64(values: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    values.get(key).and_then(Value::as_f64)
}

fn write_json_atomically(path: &Path, value: &impl Serialize, label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {label} directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("cannot create temporary {label} file: {error}"))?;
    serde_json::to_writer_pretty(&mut temporary, value)
        .map_err(|error| format!("cannot encode {label}: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("cannot sync {label}: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("cannot replace {label}: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_document(path: &Path, value: Value) {
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn project_preference_reader_accepts_other_profiles_and_preserves_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences-v1.json");
        write_document(
            &path,
            serde_json::json!({
                "schemaVersion": 1,
                "profiles": {
                    "tui": {
                        "settings": { "UseMouse": "YES" },
                        "client": { "futureTuiField": true },
                        "futureProfileField": { "nested": true }
                    },
                    "tauri": {
                        "settings": { "UseMouse": "NO" },
                        "client": { "masterVolume": 0.4 }
                    }
                }
            }),
        );

        let mut document = read_project_preference_document(&path).unwrap();
        let preserved = serde_json::to_value(document.profiles.get("tui").unwrap()).unwrap();
        document.profiles.insert(
            "tauri".into(),
            profile_from_values(BTreeMap::new(), Some(1.5), None, Some(false)),
        );
        write_json_atomically(&path, &document, "project preferences").unwrap();
        let rewritten: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();

        assert_eq!(rewritten["profiles"]["tui"], preserved);
        assert_eq!(rewritten["profiles"]["tauri"]["client"]["imageScale"], 1.5);
        assert_eq!(
            rewritten["profiles"]["tauri"]["client"]["trustProjectFileMetadata"],
            false
        );
    }

    #[test]
    fn project_preference_reader_rejects_future_or_invalid_active_profiles() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preferences-v1.json");
        for value in [
            serde_json::json!({ "schemaVersion": 2, "profiles": {} }),
            serde_json::json!({
                "schemaVersion": 1,
                "profiles": { "tauri": { "settings": {}, "client": { "future": true } } }
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "profiles": { "tauri": { "settings": {}, "client": { "imageScale": 9 } } }
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "profiles": { "tauri": { "settings": {}, "client": {}, "future": true } }
            }),
        ] {
            write_document(&path, value);
            assert_eq!(
                read_project_preference_document(&path).unwrap_err().kind(),
                std::io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn project_preference_values_normalize_only_finite_supported_ranges() {
        let normalized = ProjectPreferences {
            settings: BTreeMap::from([("UseMouse".into(), "NO".into())]),
            image_scale: Some(f64::INFINITY),
            master_volume: Some(-1.0),
            trust_project_file_metadata: Some(true),
        }
        .normalized();

        assert_eq!(
            normalized.settings.get("UseMouse").map(String::as_str),
            Some("NO")
        );
        assert_eq!(normalized.image_scale, None);
        assert_eq!(normalized.master_volume, Some(0.0));
        assert_eq!(normalized.trust_project_file_metadata, Some(true));
    }
}
