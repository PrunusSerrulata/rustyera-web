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
mod memory;
mod preferences;
mod project;
mod services;
mod storage;

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use era_debug_protocol::DebugMessage;
use era_runtime::{
    ProjectProgress, ProjectProgressReporter, ProjectProgressStage, RuntimeDriveBudget,
};
use era_runtime_protocol::{RuntimeMessage, StorageRequest, StorageResponse};
use era_web_bridge::{FRONTEND_PUMP_MAXIMUM_QUIET_SLICES, WebSession, WebSessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::export::AtomicFileWriter;
use crate::ipc::{
    decode_bytes as decode_ipc_bytes, decode_value as decode_ipc_value,
    encode_pump_response as encode_ipc_response,
    encode_submitted_pump_response as encode_submitted_ipc_response,
    encode_value as encode_ipc_value,
};
use crate::project::{ProjectFontSource, ProjectHost, ProjectReloadScope, ProjectReloadTargets};
use crate::services::native_service;
use crate::storage::StorageHost;

#[derive(Clone, Default)]
struct AppState {
    session: Arc<Mutex<Option<WebSession>>>,
    project: Arc<Mutex<Option<ProjectHost>>>,
    project_preferences: Arc<Mutex<Option<preferences::ProjectPreferenceLocation>>>,
    storage: Arc<Mutex<Option<StorageHost>>>,
    cache_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
    export_writer: Arc<Mutex<Option<AtomicFileWriter>>>,
    full_project_cancelled: Arc<AtomicBool>,
    full_manifest_spool: Arc<Mutex<Option<NativeManifestSpool>>>,
}

struct NativeManifestSpool {
    file: tempfile::NamedTempFile,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedManifestDescriptor {
    total_bytes: u64,
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
        retire_runtime_state(&state)?;
        let mut session = WebSession::new(options)?;
        let progress_app = app.clone();
        session.set_project_progress_reporter(Some(ProjectProgressReporter::new(
            move |progress| {
                let _ = progress_app.emit("project-progress", progress);
            },
        )));
        let initial = session.pump(RuntimeDriveBudget::default())?;
        let response = encode_ipc_response(&initial)?;
        *state.session.lock().map_err(lock_error)? = Some(session);
        Ok(response)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn destroy_session(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || retire_runtime_state(&state))
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

const FRONTEND_DRIVE_BUDGET: RuntimeDriveBudget = RuntimeDriveBudget {
    maximum_vm_instructions: 100_000,
    maximum_runtime_transitions: 1024,
};
const MESSAGE_SKIP_MAXIMUM_OBSERVABLE_BATCHES: usize = 128;
const NATIVE_PUMP_MAXIMUM_EXTERNAL_REQUESTS: usize = 1024;

#[tauri::command]
async fn submit_runtime_and_pump(
    state: State<'_, AppState>,
    message: Value,
    correlation_id: Option<Value>,
) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message = decode_ipc_value::<RuntimeMessage>(message)?;
        if !matches!(&message, RuntimeMessage::Input(input) if input.message_skip) {
            return Err("submit_runtime_and_pump requires a message-skip input".to_owned());
        }
        let correlation_id = correlation_id.map(decode_ipc_value).transpose()?;
        let mut session_guard = state.session.lock().map_err(lock_error)?;
        let session = session_guard
            .as_mut()
            .ok_or_else(|| "runtime session has not been created".to_owned())?;
        let message_id = session.submit_runtime(&message, correlation_id)?;
        let mut storage_guard = state.storage.lock().map_err(lock_error)?;
        let project_guard = state.project.lock().map_err(lock_error)?;
        let batch =
            pump_message_skip_session(session, storage_guard.as_mut(), project_guard.as_ref())?;
        encode_submitted_ipc_response(message_id, &batch)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn stage_full_project_manifest(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StagedManifestDescriptor, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.full_project_cancelled.store(false, Ordering::Relaxed);
        *state.full_manifest_spool.lock().map_err(lock_error)? = None;
        let progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let mut spool = tempfile::NamedTempFile::new()
            .map_err(|error| format!("cannot create full manifest spool: {error}"))?;
        let total_bytes = {
            let mut project = state.project.lock().map_err(lock_error)?;
            project
                .as_mut()
                .ok_or_else(|| "no project is open".to_owned())?
                .write_full_manifest_with_progress_and_cancel(
                    spool.as_file_mut(),
                    Some(&progress),
                    Some(&state.full_project_cancelled),
                )?
        };
        spool
            .as_file_mut()
            .sync_all()
            .map_err(|error| format!("cannot sync full manifest spool: {error}"))?;
        *state.full_manifest_spool.lock().map_err(lock_error)? = Some(NativeManifestSpool {
            file: spool,
            total_bytes,
        });
        Ok(StagedManifestDescriptor { total_bytes })
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
async fn read_full_project_manifest_chunk(
    state: State<'_, AppState>,
    offset: u64,
    maximum_bytes: u32,
) -> Result<Vec<u8>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if maximum_bytes == 0 || maximum_bytes > 4 * 1024 * 1024 {
            return Err("full manifest chunk size is invalid".into());
        }
        let mut guard = state.full_manifest_spool.lock().map_err(lock_error)?;
        let spool = guard
            .as_mut()
            .ok_or_else(|| "full manifest spool is unavailable".to_owned())?;
        if offset > spool.total_bytes {
            return Err("full manifest chunk offset is invalid".into());
        }
        let length = usize::try_from((spool.total_bytes - offset).min(u64::from(maximum_bytes)))
            .map_err(|_| "full manifest chunk length exceeds this platform's limits")?;
        let mut bytes = vec![0_u8; length];
        spool
            .file
            .as_file_mut()
            .seek(SeekFrom::Start(offset))
            .and_then(|_| spool.file.as_file_mut().read_exact(&mut bytes))
            .map_err(|error| format!("cannot read full manifest spool: {error}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
fn release_full_project_manifest(state: State<'_, AppState>) -> Result<(), String> {
    *state.full_manifest_spool.lock().map_err(lock_error)? = None;
    Ok(())
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
        let batch = pump_frontend_session(session, storage_guard.as_mut(), project_guard.as_ref())?;
        encode_ipc_response(&batch)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

fn pump_frontend_session(
    session: &mut WebSession,
    storage: Option<&mut StorageHost>,
    project: Option<&ProjectHost>,
) -> Result<era_web_bridge::PumpBatch, String> {
    if let Some(storage) = storage {
        session.pump_with_native_host(
            FRONTEND_DRIVE_BUDGET,
            FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
            NATIVE_PUMP_MAXIMUM_EXTERNAL_REQUESTS,
            |request| storage.handle(request),
            |request| native_service(request, project),
        )
    } else {
        session.pump_quiet(FRONTEND_DRIVE_BUDGET, FRONTEND_PUMP_MAXIMUM_QUIET_SLICES)
    }
}

fn pump_message_skip_session(
    session: &mut WebSession,
    storage: Option<&mut StorageHost>,
    project: Option<&ProjectHost>,
) -> Result<era_web_bridge::PumpBatch, String> {
    if let Some(storage) = storage {
        session.pump_with_native_host_until_blocked(
            FRONTEND_DRIVE_BUDGET,
            FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
            MESSAGE_SKIP_MAXIMUM_OBSERVABLE_BATCHES,
            NATIVE_PUMP_MAXIMUM_EXTERNAL_REQUESTS,
            |request| storage.handle(request),
            |request| native_service(request, project),
        )
    } else {
        session.pump_until_blocked(
            FRONTEND_DRIVE_BUDGET,
            FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
            MESSAGE_SKIP_MAXIMUM_OBSERVABLE_BATCHES,
        )
    }
}

#[tauri::command]
async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ProjectOpenMetrics, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        retire_project_state(&state)?;
        let scan_progress = |completed, total| emit_scanning_progress(&app, completed, total);
        let started = Instant::now();
        let source_index_trusted = preferences::effective_source_metadata_trust(&app, &path)?;
        let mut host = ProjectHost::scan_quick_with_progress_and_trust(
            &path,
            1,
            Some(&scan_progress),
            source_index_trusted,
        )?;
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
        let storage_root = host.root().to_owned();
        install_project_state(
            &state,
            host,
            StorageHost::new(storage_root),
            preferences::ProjectPreferenceLocation {
                path: path.clone(),
                project_file: false,
            },
        )?;
        Ok(ProjectOpenMetrics {
            quick_scan_ms,
            cache_read_ms,
            source_read_ms,
            submit_ms,
            cache_imported,
            source_index_trusted: Some(source_index_trusted),
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
        retire_project_state(&state)?;
        let started = Instant::now();
        let bytes =
            fs::read(&path).map_err(|error| format!("cannot read project file: {error}"))?;
        let host = ProjectHost::from_project_file(&path, &bytes)?;
        let identity = host.identity();
        let sidecar = match host.compiled_cache() {
            Ok(cache) => cache,
            Err(error) => {
                eprintln!("ignoring unreadable packaged-project cache: {error}");
                None
            }
        };
        if let Some(sidecar) = sidecar {
            if let Err(error) = with_session(&state, |session| {
                session.load_project_with_compiled_cache(identity.clone(), sidecar)
            }) {
                eprintln!("ignoring unusable packaged-project cache: {error}");
                with_session(&state, |session| {
                    session.load_project_with_compiled_cache(identity, bytes)
                })?;
            }
        } else {
            with_session(&state, |session| {
                session.load_project_with_compiled_cache(identity, bytes)
            })?;
        }
        let submit_ms = started.elapsed().as_secs_f64() * 1000.0;
        let storage_root = host.runtime_storage_root();
        // Keep only packaged resource lookup data while the cache candidate is pending. If both a
        // refreshed sidecar and the embedded legacy cache are incompatible, `submit_project_source`
        // lazily decodes the authoritative package and transfers ownership of its source manifest.
        install_project_state(
            &state,
            host,
            StorageHost::new(storage_root),
            preferences::ProjectPreferenceLocation {
                path,
                project_file: true,
            },
        )?;
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
        let manifest = {
            let mut project = state.project.lock().map_err(lock_error)?;
            project
                .as_mut()
                .ok_or_else(|| "no project is open".to_owned())?
                .take_manifest_with_progress(Some(&scan_progress))?
        };
        let message_id = with_session(&state, |session| session.load_project(manifest))?;
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_mut()
            .ok_or_else(|| "no project is open".to_owned())?
            .mark_runtime_manifest_complete();
        Ok(message_id)
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
async fn prepare_project_reload_baseline(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?;
        // Sparse reloads hydrate lazily inside `reload_scoped_with_progress`. Retaining a fully
        // materialized baseline from cache acceptance until a possible future reload defeats the
        // native host's single-owner source policy.
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
        let request = {
            let mut project = state.project.lock().map_err(lock_error)?;
            project
                .as_mut()
                .ok_or_else(|| "no project is open".to_owned())?
                .reload_scoped_with_progress(&scope, Some(&scan_progress))?
        };
        let submitted = with_session(&state, |session| {
            session.submit_runtime(&RuntimeMessage::ReloadProject(request), None)
        });
        if submitted.is_err() {
            // Do not hold the project mutex while acquiring the session mutex. The pump path owns
            // those locks in session -> storage -> project order.
            if let Ok(mut project) = state.project.lock()
                && let Some(host) = project.as_mut()
            {
                host.finalize_reload(false);
            }
        }
        submitted
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

fn retire_runtime_state(state: &AppState) -> Result<(), String> {
    let session = state.session.lock().map_err(lock_error)?.take();
    drop(session);
    retire_project_state(state)
}

fn retire_project_state(state: &AppState) -> Result<(), String> {
    state.full_project_cancelled.store(true, Ordering::Relaxed);
    let spool = state.full_manifest_spool.lock().map_err(lock_error)?.take();
    drop(spool);
    let cache_writer = state.cache_writer.lock().map_err(lock_error)?.take();
    drop(cache_writer);
    let storage = state.storage.lock().map_err(lock_error)?.take();
    drop(storage);
    let project = state.project.lock().map_err(lock_error)?.take();
    drop(project);
    let preferences = state.project_preferences.lock().map_err(lock_error)?.take();
    drop(preferences);
    Ok(())
}

fn install_project_state(
    state: &AppState,
    project: ProjectHost,
    storage: StorageHost,
    preferences: preferences::ProjectPreferenceLocation,
) -> Result<(), String> {
    // Match the pump's storage -> project lock order and acquire every destination before
    // publishing any owner, so a poisoned lock cannot leave a half-installed project.
    let mut storage_slot = state.storage.lock().map_err(lock_error)?;
    let mut project_slot = state.project.lock().map_err(lock_error)?;
    let mut preference_slot = state.project_preferences.lock().map_err(lock_error)?;
    *storage_slot = Some(storage);
    *project_slot = Some(project);
    *preference_slot = Some(preferences);
    Ok(())
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
            destroy_session,
            submit_runtime,
            submit_runtime_and_pump,
            stage_full_project_manifest,
            read_full_project_manifest_chunk,
            release_full_project_manifest,
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
            memory::memory_snapshot,
            preferences::load_preferences,
            preferences::save_preferences,
            preferences::load_project_preferences,
            preferences::save_project_preferences,
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
