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

mod export;
mod image_metadata;
mod ipc;
mod preferences;
mod project;
mod storage;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use era_debug_protocol::DebugMessage;
use era_protocol::{ProtocolBytes, decode_canonical, encode_canonical};
use era_runtime::{
    ProjectProgress, ProjectProgressReporter, ProjectProgressStage, RuntimeDriveBudget,
};
use era_runtime_protocol::{
    DECODE_CANVAS_IMAGE_OPERATION, DecodeCanvasImageRequest, DecodeCanvasImageResponse,
    FullProjectManifest, IMAGE_METADATA_OPERATION, ImageMetadataRequest, ImageMetadataResponse,
    RuntimeMessage, ServiceKind, ServiceRequest, ServiceResponse, ServiceResult, StorageRequest,
    StorageResponse,
};
use era_web_bridge::{FRONTEND_PUMP_MAXIMUM_QUIET_SLICES, WebSession, WebSessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::export::AtomicFileWriter;
use crate::ipc::{
    decode_bytes as decode_ipc_bytes, decode_value as decode_ipc_value,
    encode_pump_response as encode_ipc_response, encode_value as encode_ipc_value,
};
use crate::project::{ProjectFontSource, ProjectHost, ProjectReloadScope, ProjectReloadTargets};
use crate::storage::StorageHost;

#[derive(Clone, Default)]
struct AppState {
    session: Arc<Mutex<Option<WebSession>>>,
    project: Arc<Mutex<Option<ProjectHost>>>,
    storage: Arc<Mutex<Option<StorageHost>>>,
    cache_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
    export_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
    full_project_cancelled: Arc<AtomicBool>,
}

fn emit_scanning_progress(app: &AppHandle, completed: usize, total: usize) {
    let _ = app.emit(
        "project-progress",
        ProjectProgress {
            stage: ProjectProgressStage::Scanning,
            completed: u64::try_from(completed).unwrap_or(u64::MAX),
            total: u64::try_from(total).unwrap_or(u64::MAX),
        },
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOpenMetrics {
    quick_scan_ms: f64,
    cache_read_ms: f64,
    source_read_ms: f64,
    submit_ms: f64,
    cache_imported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_index_trusted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_index_reused_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_index_hashed_files: Option<usize>,
}

#[tauri::command]
async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    options: WebSessionOptions,
) -> Result<tauri::ipc::Response, String> {
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
        encode_ipc_response(&initial)
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
async fn stage_full_project_manifest(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.full_project_cancelled.store(false, Ordering::Relaxed);
        let progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let manifest = {
            let mut project = state.project.lock().map_err(lock_error)?;
            project
                .as_mut()
                .ok_or_else(|| "no project is open".to_owned())?
                .materialize_with_progress_and_cancel(
                    Some(&progress),
                    Some(&state.full_project_cancelled),
                )?
                .clone()
        };
        with_session(&state, |session| {
            session.submit_runtime(
                &RuntimeMessage::FullProjectManifest(FullProjectManifest { manifest }),
                None,
            )
        })?;
        Ok(())
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
fn cancel_full_project_export(state: State<'_, AppState>) {
    state.full_project_cancelled.store(true, Ordering::Relaxed);
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
async fn pump(state: State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session_guard = state.session.lock().map_err(lock_error)?;
        let session = session_guard
            .as_mut()
            .ok_or_else(|| "runtime session has not been created".to_owned())?;
        let mut storage_guard = state.storage.lock().map_err(lock_error)?;
        let project_guard = state.project.lock().map_err(lock_error)?;
        let budget = RuntimeDriveBudget {
            maximum_vm_instructions: 100_000,
            maximum_runtime_transitions: 1024,
        };
        let batch = if let Some(storage) = storage_guard.as_mut() {
            session.pump_with_native_host(
                budget,
                FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
                1024,
                |request| storage.handle(request),
                |request| native_service(request, project_guard.as_ref()),
            )?
        } else {
            session.pump_quiet(budget, FRONTEND_PUMP_MAXIMUM_QUIET_SLICES)?
        };
        encode_ipc_response(&batch)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

fn native_service(
    request: ServiceRequest,
    project: Option<&ProjectHost>,
) -> Option<ServiceResponse> {
    let payload = match (request.kind, request.operation.as_str()) {
        (ServiceKind::Canvas, DECODE_CANVAS_IMAGE_OPERATION) => {
            let decoded: DecodeCanvasImageRequest =
                decode_canonical(request.payload.as_slice()).ok()?;
            let metadata = image_metadata::decode(decoded.encoded.as_slice())?;
            encode_canonical(&DecodeCanvasImageResponse {
                width: metadata.width,
                height: metadata.height,
            })
            .ok()?
        }
        (ServiceKind::Image, IMAGE_METADATA_OPERATION) => {
            let decoded: ImageMetadataRequest =
                decode_canonical(request.payload.as_slice()).ok()?;
            let bytes = project?
                .read_resource_prefix(&decoded.resource_id, 1024 * 1024)
                .ok()?;
            let metadata = image_metadata::decode(&bytes)?;
            encode_canonical(&ImageMetadataResponse {
                width: metadata.width,
                height: metadata.height,
                format: metadata.format.into(),
                animated: metadata.animated,
            })
            .ok()?
        }
        _ => return None,
    };
    Some(ServiceResponse {
        request_id: request.request_id,
        result: ServiceResult::Ready {
            payload: ProtocolBytes::new(payload),
        },
    })
}

#[tauri::command]
async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ProjectOpenMetrics, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let started = Instant::now();
        let mut host = ProjectHost::scan_quick_with_progress(&path, 1, Some(&scan_progress))?;
        let (source_index_reused_files, source_index_hashed_files) = host.source_index_stats();
        let quick_scan_ms = started.elapsed().as_secs_f64() * 1000.0;
        let identity = host.identity();
        let cache_started = Instant::now();
        let cache = host.compiled_cache()?;
        let cache_read_ms = cache_started.elapsed().as_secs_f64() * 1000.0;
        let mut source_read_ms = 0.0;
        let submit_started = Instant::now();
        let cache_imported = if let Some(cache) = cache {
            if with_session(&state, |session| {
                session.load_project_with_compiled_cache(identity, cache)
            })
            .is_ok()
            {
                host.mark_runtime_manifest_sparse();
                true
            } else {
                let source_started = Instant::now();
                let manifest = host.retained_manifest_with_progress(Some(&scan_progress))?;
                source_read_ms = source_started.elapsed().as_secs_f64() * 1000.0;
                with_session(&state, |session| session.load_project(manifest))?;
                false
            }
        } else {
            let source_started = Instant::now();
            let manifest = host.retained_manifest_with_progress(Some(&scan_progress))?;
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
            source_index_trusted: Some(true),
            source_index_reused_files: Some(source_index_reused_files),
            source_index_hashed_files: Some(source_index_hashed_files),
        })
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn open_project_file(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ProjectOpenMetrics, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let bytes =
            fs::read(&path).map_err(|error| format!("cannot read project file: {error}"))?;
        let host = ProjectHost::from_project_file(&path, &bytes)?;
        let identity = host.identity();
        with_session(&state, |session| {
            session.load_project_with_compiled_cache(identity, bytes)
        })?;
        let submit_ms = started.elapsed().as_secs_f64() * 1000.0;
        let storage_key = blake3::hash(path.to_string_lossy().as_bytes()).to_hex();
        let storage_root = host
            .root()
            .join(".rustyera/packaged-projects")
            .join(storage_key.as_str());
        *state.storage.lock().map_err(lock_error)? = Some(StorageHost::new(storage_root));
        // Keep the embedded manifest until the runtime accepts the compiled snapshot. A project
        // file exported after legacy-configuration migration can legitimately require a source
        // fallback because its embedded source identity differs from the cached build identity.
        // `submit_project_source` clones this retained manifest when the runtime requests it.
        *state.project.lock().map_err(lock_error)? = Some(host);
        Ok(ProjectOpenMetrics {
            quick_scan_ms: 0.0,
            cache_read_ms: 0.0,
            source_read_ms: 0.0,
            submit_ms,
            cache_imported: true,
            source_index_trusted: None,
            source_index_reused_files: None,
            source_index_hashed_files: None,
        })
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn submit_project_source(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let manifest = state
            .project
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?
            .retained_manifest_with_progress(Some(&scan_progress))?;
        with_session(&state, |session| session.load_project(manifest))
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn project_reload_targets(
    state: State<'_, AppState>,
) -> Result<ProjectReloadTargets, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?
            .project_reload_targets()
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn prepare_project_reload_baseline(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| emit_scanning_progress(&app, completed, total);
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?
            .materialize_with_progress(Some(&scan_progress))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn reload_project(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: ProjectReloadScope,
) -> Result<u64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan_progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let mut project = state.project.lock().map_err(lock_error)?;
        let host = project
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?;
        let request = host.reload_scoped_with_progress(&scope, Some(&scan_progress))?;
        match with_session(&state, |session| {
            session.submit_runtime(&RuntimeMessage::ReloadProject(request), None)
        }) {
            Ok(message_id) => Ok(message_id),
            Err(error) => {
                host.finalize_reload(false);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn finalize_project_reload(state: State<'_, AppState>, success: bool) -> Result<(), String> {
    state
        .project
        .lock()
        .map_err(lock_error)?
        .as_mut()
        .ok_or_else(|| "no project is open".to_owned())?
        .finalize_reload(success);
    Ok(())
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
fn project_font_sources(state: State<'_, AppState>) -> Result<Vec<ProjectFontSource>, String> {
    Ok(state
        .project
        .lock()
        .map_err(lock_error)?
        .as_ref()
        .ok_or_else(|| "no project is open".to_owned())?
        .font_sources())
}

#[tauri::command]
async fn read_project_font(
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
            .read_font(&relative_path)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn write_project_configuration(
    state: State<'_, AppState>,
    expected_digest: Vec<u8>,
    contents: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut project = state.project.lock().map_err(lock_error)?;
        let project = project
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?;
        project.write_configuration(&expected_digest, &contents)?;
        project.invalidate_compiled_cache();
        Ok(())
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
            stage_full_project_manifest,
            submit_debug,
            pump,
            open_project,
            open_project_file,
            submit_project_source,
            project_reload_targets,
            prepare_project_reload_baseline,
            reload_project,
            finalize_project_reload,
            read_resource,
            read_resource_prefix,
            project_font_sources,
            read_project_font,
            write_project_configuration,
            storage_request,
            list_fonts,
            preferences::load_preferences,
            preferences::save_preferences,
            export::write_export,
            export::write_export_chunk,
            export::cancel_export,
            cancel_full_project_export,
            export::write_compiled_cache_chunk,
            export::cancel_compiled_cache_export,
            export::read_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RustyEra web frontend");
}

#[cfg(test)]
mod tests;
