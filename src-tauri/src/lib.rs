//! Native host for the shared Vue web frontend.

#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be owned deserializable values"
)]

// Real Era projects create millions of short-lived parser and compiler allocations.
// macOS's default zone allocator retains and fragments those pages across the later VM
// startup phase, so the standalone host uses an allocator designed for this workload.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod project;
mod storage;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use era_debug_protocol::DebugMessage;
use era_runtime::{
    ProjectProgress, ProjectProgressReporter, ProjectProgressStage, RuntimeDriveBudget,
};
use era_runtime_protocol::{RuntimeMessage, StorageRequest, StorageResponse};
use era_web_bridge::{WebSession, WebSessionOptions};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::project::ProjectHost;
use crate::storage::StorageHost;

#[derive(Clone, Default)]
struct AppState {
    session: Arc<Mutex<Option<WebSession>>>,
    project: Arc<Mutex<Option<ProjectHost>>>,
    storage: Arc<Mutex<Option<StorageHost>>>,
    cache_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
    export_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
}

struct AtomicFileWriter {
    temporary: tempfile::NamedTempFile,
    target: PathBuf,
}

const MAXIMUM_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
const MINIMUM_SAFE_JAVASCRIPT_INTEGER: i64 = -9_007_199_254_740_991;
const IPC_INTEGER_TAG: &str = "$rustyeraInteger";

fn encode_ipc_value<T: Serialize>(value: &T) -> Result<Value, String> {
    let mut value = serde_json::to_value(value)
        .map_err(|error| format!("cannot encode IPC response: {error}"))?;
    tag_unsafe_integers(&mut value);
    Ok(value)
}

fn decode_ipc_value<T: DeserializeOwned>(mut value: Value) -> Result<T, String> {
    untag_unsafe_integers(&mut value)?;
    serde_json::from_value(value).map_err(|error| format!("cannot decode IPC request: {error}"))
}

fn tag_unsafe_integers(value: &mut Value) {
    match value {
        Value::Number(number) if is_unsafe_javascript_integer(number) => {
            let mut tagged = Map::new();
            tagged.insert(
                IPC_INTEGER_TAG.to_owned(),
                Value::String(number.to_string()),
            );
            *value = Value::Object(tagged);
        }
        Value::Array(items) => items.iter_mut().for_each(tag_unsafe_integers),
        Value::Object(fields) => fields.values_mut().for_each(tag_unsafe_integers),
        _ => {}
    }
}

fn is_unsafe_javascript_integer(number: &Number) -> bool {
    number
        .as_u64()
        .is_some_and(|value| value > MAXIMUM_SAFE_JAVASCRIPT_INTEGER)
        || number
            .as_i64()
            .is_some_and(|value| value < MINIMUM_SAFE_JAVASCRIPT_INTEGER)
}

fn untag_unsafe_integers(value: &mut Value) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for item in items {
                untag_unsafe_integers(item)?;
            }
        }
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(IPC_INTEGER_TAG) => {
            let encoded = fields
                .get(IPC_INTEGER_TAG)
                .and_then(Value::as_str)
                .ok_or_else(|| "invalid tagged IPC integer".to_owned())?;
            *value = Value::Number(
                encoded
                    .parse::<Number>()
                    .map_err(|error| format!("invalid tagged IPC integer: {error}"))?,
            );
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                untag_unsafe_integers(field)?;
            }
        }
        _ => {}
    }
    Ok(())
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOpenMetrics {
    quick_scan_ms: f64,
    cache_read_ms: f64,
    source_read_ms: f64,
    submit_ms: f64,
    cache_imported: bool,
}

impl Preferences {
    fn normalized(mut self) -> Self {
        self.schema_version = 1;
        self.font_size_override_px = Some(self.font_size_override_px.unwrap_or(12).clamp(8, 72));
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
async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    options: WebSessionOptions,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = WebSession::new(options)?;
        let progress_app = app.clone();
        session.set_project_progress_reporter(Some(ProjectProgressReporter::new(
            move |progress| {
                let _ = progress_app.emit("project-progress", progress);
            },
        )));
        let initial = session.pump(RuntimeDriveBudget::default())?;
        *state.session.lock().map_err(lock_error)? = Some(session);
        encode_ipc_value(&initial)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn submit_runtime(
    state: State<'_, AppState>,
    message: Value,
    correlation_id: Option<Value>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message = decode_ipc_value::<RuntimeMessage>(message)?;
        let correlation_id = correlation_id.map(decode_ipc_value).transpose()?;
        let message_id = with_session(&state, |session| {
            session.submit_runtime(&message, correlation_id)
        })?;
        encode_ipc_value(&message_id)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn submit_debug(
    state: State<'_, AppState>,
    message: Value,
    correlation_id: Option<Value>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message = decode_ipc_value::<DebugMessage>(message)?;
        let correlation_id = correlation_id.map(decode_ipc_value).transpose()?;
        let message_id = with_session(&state, |session| {
            session.submit_debug(&message, correlation_id)
        })?;
        encode_ipc_value(&message_id)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn pump(state: State<'_, AppState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let batch = with_session(&state, |session| {
            session.pump(RuntimeDriveBudget {
                maximum_vm_instructions: 100_000,
                maximum_runtime_transitions: 1024,
            })
        })?;
        encode_ipc_value(&batch)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ProjectOpenMetrics, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| {
            let _ = app.emit(
                "project-progress",
                ProjectProgress {
                    stage: ProjectProgressStage::Scanning,
                    completed: u64::try_from(completed).unwrap_or(u64::MAX),
                    total: u64::try_from(total).unwrap_or(u64::MAX),
                },
            );
        };
        let started = Instant::now();
        let mut host = ProjectHost::scan_quick_with_progress(&path, 1, Some(&scan_progress))?;
        let quick_scan_ms = started.elapsed().as_secs_f64() * 1000.0;
        let identity = host.identity();
        let cache_started = Instant::now();
        let cache = host.compiled_cache()?;
        let cache_read_ms = cache_started.elapsed().as_secs_f64() * 1000.0;
        let mut source_read_ms = 0.0;
        let submit_started = Instant::now();
        let cache_imported = if let Some(cache) = cache {
            if with_session(&state, |session| {
                session.load_project_with_compiled_cache(identity, &cache)
            })
            .is_ok()
            {
                true
            } else {
                let source_started = Instant::now();
                let manifest = host.take_manifest_with_progress(Some(&scan_progress))?;
                source_read_ms = source_started.elapsed().as_secs_f64() * 1000.0;
                with_session(&state, |session| session.load_project(manifest))?;
                false
            }
        } else {
            let source_started = Instant::now();
            let manifest = host.take_manifest_with_progress(Some(&scan_progress))?;
            source_read_ms = source_started.elapsed().as_secs_f64() * 1000.0;
            with_session(&state, |session| session.load_project(manifest))?;
            false
        };
        let submit_ms = submit_started.elapsed().as_secs_f64() * 1000.0 - source_read_ms;
        *state.storage.lock().map_err(lock_error)? = Some(StorageHost::new(host.root().to_owned()));
        *state.project.lock().map_err(lock_error)? = Some(host);
        Ok(ProjectOpenMetrics {
            quick_scan_ms,
            cache_read_ms,
            source_read_ms,
            submit_ms,
            cache_imported,
        })
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn submit_project_source(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| {
            let _ = app.emit(
                "project-progress",
                ProjectProgress {
                    stage: ProjectProgressStage::Scanning,
                    completed: u64::try_from(completed).unwrap_or(u64::MAX),
                    total: u64::try_from(total).unwrap_or(u64::MAX),
                },
            );
        };
        let manifest = state
            .project
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?
            .take_manifest_with_progress(Some(&scan_progress))?;
        with_session(&state, |session| session.load_project(manifest))
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn reload_project(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| {
            let _ = app.emit(
                "project-progress",
                ProjectProgress {
                    stage: ProjectProgressStage::Scanning,
                    completed: u64::try_from(completed).unwrap_or(u64::MAX),
                    total: u64::try_from(total).unwrap_or(u64::MAX),
                },
            );
        };
        let request = state
            .project
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?
            .reload_with_progress(Some(&scan_progress))?;
        with_session(&state, |session| {
            session.submit_runtime(&RuntimeMessage::ReloadProject(request), None)
        })
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn read_resource(
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?
            .read_resource(&relative_path)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn read_resource_prefix(
    state: State<'_, AppState>,
    relative_path: String,
    maximum_bytes: u32,
) -> Result<Vec<u8>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?
            .read_resource_prefix(&relative_path, maximum_bytes.min(4 * 1024 * 1024))
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn storage_request(
    state: State<'_, AppState>,
    request: StorageRequest,
) -> Result<StorageResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = state
            .storage
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project storage is open".to_owned())?
            .handle(request);
        Ok(response)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
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
async fn write_export_chunk(
    state: State<'_, AppState>,
    path: PathBuf,
    bytes: Vec<u8>,
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic_file_chunk(&state.export_writer, Some(path), &bytes, reset, complete)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    state.export_writer.lock().map_err(lock_error)?.take();
    Ok(())
}

#[tauri::command]
async fn write_compiled_cache_chunk(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_compiled_cache_chunk_inner(&state, &bytes, reset, complete)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

fn write_compiled_cache_chunk_inner(
    state: &AppState,
    bytes: &[u8],
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    if reset {
        let root = state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?
            .root()
            .to_owned();
        let directory = root.join(".rustyera/cache");
        fs::create_dir_all(&directory)
            .map_err(|error| format!("cannot create compiled cache directory: {error}"))?;
        let target = directory.join("compiled-project-v8.bin.zst");
        let temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|error| format!("cannot create temporary compiled cache: {error}"))?;
        *state.cache_writer.lock().map_err(lock_error)? =
            Some(AtomicFileWriter { temporary, target });
    }
    append_atomic_file_chunk(
        &state.cache_writer,
        bytes,
        complete,
        "compiled cache write has not started",
        "compiled cache writer disappeared",
        "compiled cache",
    )
}

fn write_atomic_file_chunk(
    slot: &Mutex<Option<AtomicFileWriter>>,
    target: Option<PathBuf>,
    bytes: &[u8],
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    if reset {
        let target = target.ok_or_else(|| "export path is missing".to_owned())?;
        let parent = target
            .parent()
            .ok_or_else(|| "export path has no parent".to_owned())?;
        let temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("cannot create temporary export file: {error}"))?;
        *slot.lock().map_err(lock_error)? = Some(AtomicFileWriter { temporary, target });
    }
    append_atomic_file_chunk(
        slot,
        bytes,
        complete,
        "export write has not started",
        "export writer disappeared",
        "export file",
    )
}

fn append_atomic_file_chunk(
    slot: &Mutex<Option<AtomicFileWriter>>,
    bytes: &[u8],
    complete: bool,
    missing_message: &str,
    disappeared_message: &str,
    file_kind: &str,
) -> Result<(), String> {
    let mut guard = slot.lock().map_err(lock_error)?;
    let writer = guard.as_mut().ok_or_else(|| missing_message.to_owned())?;
    std::io::Write::write_all(&mut writer.temporary, bytes)
        .map_err(|error| format!("cannot write {file_kind}: {error}"))?;
    if complete {
        let writer = guard.take().ok_or_else(|| disappeared_message.to_owned())?;
        writer
            .temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("cannot sync {file_kind}: {error}"))?;
        writer
            .temporary
            .persist(writer.target)
            .map_err(|error| format!("cannot replace {file_kind}: {}", error.error))?;
    }
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
        font_size_override_px: Some(12),
        image_scale: 1.0,
        master_volume: 1.0,
    }
}

fn with_session<T>(
    state: &AppState,
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
    let builder = tauri::Builder::default();
    #[cfg(feature = "webdriver")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            submit_runtime,
            submit_debug,
            pump,
            open_project,
            submit_project_source,
            reload_project,
            read_resource,
            read_resource_prefix,
            storage_request,
            list_fonts,
            load_preferences,
            save_preferences,
            write_export,
            write_export_chunk,
            cancel_export,
            write_compiled_cache_chunk,
            read_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RustyEra web frontend");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_cache_chunks_are_atomically_persisted() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("ERB")).unwrap();
        fs::write(directory.path().join("ERB/test.erb"), "@TEST\nRETURN").unwrap();
        let state = AppState::default();
        *state.project.lock().unwrap() =
            Some(ProjectHost::scan_quick(directory.path(), 1).unwrap());

        write_compiled_cache_chunk_inner(&state, b"first", true, false).unwrap();
        write_compiled_cache_chunk_inner(&state, b"second", false, true).unwrap();

        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join(".rustyera/cache/compiled-project-v8.bin.zst")
            )
            .unwrap(),
            b"firstsecond"
        );
        assert!(state.cache_writer.lock().unwrap().is_none());
    }

    #[test]
    fn export_chunks_are_atomically_persisted() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("diagnosis.tar.zst");
        let state = AppState::default();

        write_atomic_file_chunk(
            &state.export_writer,
            Some(target.clone()),
            b"first",
            true,
            false,
        )
        .unwrap();
        assert!(!target.exists());
        write_atomic_file_chunk(&state.export_writer, None, b"second", false, true).unwrap();

        assert_eq!(fs::read(target).unwrap(), b"firstsecond");
        assert!(state.export_writer.lock().unwrap().is_none());
    }

    #[test]
    fn missing_or_legacy_font_size_normalizes_to_twelve_pixels() {
        let normalized = Preferences {
            font_size_override_px: None,
            ..default_preferences()
        }
        .normalized();

        assert_eq!(normalized.font_size_override_px, Some(12));
    }

    #[test]
    fn ipc_transport_round_trips_integers_outside_javascript_safe_range() {
        let original = serde_json::json!({
            "positive": 4_919_414_282_687_566_401_u64,
            "negative": -9_007_199_254_740_992_i64,
            "safe": MAXIMUM_SAFE_JAVASCRIPT_INTEGER,
        });

        let encoded = encode_ipc_value(&original).unwrap();
        assert_eq!(encoded["positive"][IPC_INTEGER_TAG], "4919414282687566401");
        assert_eq!(encoded["negative"][IPC_INTEGER_TAG], "-9007199254740992");
        assert_eq!(encoded["safe"], MAXIMUM_SAFE_JAVASCRIPT_INTEGER);
        assert_eq!(decode_ipc_value::<Value>(encoded).unwrap(), original);
    }
}
