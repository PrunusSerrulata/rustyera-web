//! Native host for the shared Vue web frontend.

#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be owned deserializable values"
)]

mod project;
mod storage;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use era_debug_protocol::DebugMessage;
use era_runtime::RuntimeDriveBudget;
use era_runtime_protocol::{RuntimeMessage, StorageRequest, StorageResponse};
use era_web_bridge::{PumpBatch, WebSession, WebSessionOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::project::ProjectHost;
use crate::storage::StorageHost;

#[derive(Default)]
struct AppState {
    session: Mutex<Option<WebSession>>,
    project: Mutex<Option<ProjectHost>>,
    storage: Mutex<Option<StorageHost>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    schema_version: u32,
    font_family_override: Option<String>,
    font_size_override_px: Option<u8>,
    image_scale: f64,
    master_volume: f64,
}

impl Preferences {
    fn normalized(mut self) -> Self {
        self.schema_version = 1;
        self.font_size_override_px = self.font_size_override_px.map(|size| size.clamp(8, 72));
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
fn create_session(
    state: State<'_, AppState>,
    options: WebSessionOptions,
) -> Result<PumpBatch, String> {
    let mut session = WebSession::new(options)?;
    let initial = session.pump(RuntimeDriveBudget::default())?;
    *state.session.lock().map_err(lock_error)? = Some(session);
    Ok(initial)
}

#[tauri::command]
fn submit_runtime(
    state: State<'_, AppState>,
    message: RuntimeMessage,
    correlation_id: Option<u64>,
) -> Result<u64, String> {
    with_session(&state, |session| {
        session.submit_runtime(&message, correlation_id)
    })
}

#[tauri::command]
fn submit_debug(
    state: State<'_, AppState>,
    message: DebugMessage,
    correlation_id: Option<u64>,
) -> Result<u64, String> {
    with_session(&state, |session| {
        session.submit_debug(&message, correlation_id)
    })
}

#[tauri::command]
fn pump(state: State<'_, AppState>) -> Result<PumpBatch, String> {
    with_session(&state, |session| {
        session.pump(RuntimeDriveBudget {
            maximum_vm_instructions: 100_000,
            maximum_runtime_transitions: 1024,
        })
    })
}

#[tauri::command]
fn open_project(state: State<'_, AppState>, path: PathBuf) -> Result<u64, String> {
    let host = ProjectHost::scan(&path, 1)?;
    let manifest = host.manifest().clone();
    let message_id = with_session(&state, |session| session.load_project(manifest))?;
    *state.storage.lock().map_err(lock_error)? = Some(StorageHost::new(host.root().to_owned()));
    *state.project.lock().map_err(lock_error)? = Some(host);
    Ok(message_id)
}

#[tauri::command]
fn reload_project(state: State<'_, AppState>) -> Result<u64, String> {
    let request = state
        .project
        .lock()
        .map_err(lock_error)?
        .as_mut()
        .ok_or_else(|| "no project is open".to_owned())?
        .reload()?;
    with_session(&state, |session| {
        session.submit_runtime(&RuntimeMessage::ReloadProject(request), None)
    })
}

#[tauri::command]
fn read_resource(state: State<'_, AppState>, relative_path: String) -> Result<Vec<u8>, String> {
    state
        .project
        .lock()
        .map_err(lock_error)?
        .as_ref()
        .ok_or_else(|| "no project is open".to_owned())?
        .read_resource(&relative_path)
}

#[tauri::command]
fn storage_request(
    state: State<'_, AppState>,
    request: StorageRequest,
) -> Result<StorageResponse, String> {
    let response = state
        .storage
        .lock()
        .map_err(lock_error)?
        .as_mut()
        .ok_or_else(|| "no project storage is open".to_owned())?
        .handle(request);
    Ok(response)
}

#[tauri::command]
fn list_fonts() -> Vec<String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut families = database
        .faces()
        .flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
        .collect::<Vec<_>>();
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    families
}

#[tauri::command]
fn load_preferences(app: AppHandle) -> Result<Preferences, String> {
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
fn save_preferences(app: AppHandle, preferences: Preferences) -> Result<Preferences, String> {
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

#[tauri::command]
fn write_export(path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "export path has no parent".to_owned())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("cannot create export file: {error}"))?;
    std::io::Write::write_all(&mut temporary, &bytes)
        .map_err(|error| format!("cannot write export file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("cannot sync export file: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("cannot replace export file: {}", error.error))?;
    Ok(())
}

#[tauri::command]
fn read_import(path: PathBuf) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("cannot read import file: {error}"))
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("preferences-v1.json"))
        .map_err(|error| format!("cannot resolve application config directory: {error}"))
}

fn default_preferences() -> Preferences {
    Preferences {
        schema_version: 1,
        font_family_override: None,
        font_size_override_px: None,
        image_scale: 1.0,
        master_volume: 1.0,
    }
}

fn with_session<T>(
    state: &State<'_, AppState>,
    operation: impl FnOnce(&mut WebSession) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.session.lock().map_err(lock_error)?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "runtime session has not been created".to_owned())?;
    operation(session)
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("frontend state lock was poisoned: {error}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Start the native application host.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or run its application event loop.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            submit_runtime,
            submit_debug,
            pump,
            open_project,
            reload_project,
            read_resource,
            storage_request,
            list_fonts,
            load_preferences,
            save_preferences,
            write_export,
            read_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RustyEra web frontend");
}
