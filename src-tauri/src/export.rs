#[allow(clippy::wildcard_imports)]
use super::*;

pub(super) struct AtomicFileWriter {
    temporary: tempfile::NamedTempFile,
    target: PathBuf,
}

#[tauri::command]
pub(super) fn write_export(path: PathBuf, bytes: Value) -> Result<(), String> {
    let bytes = decode_ipc_bytes(bytes)?;
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
pub(super) async fn write_export_chunk(
    state: State<'_, AppState>,
    path: PathBuf,
    bytes: Value,
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    let bytes = decode_ipc_bytes(bytes)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic_file_chunk(&state.export_writer, Some(path), &bytes, reset, complete)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

#[tauri::command]
pub(super) fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    state.export_writer.lock().map_err(lock_error)?.take();
    Ok(())
}

#[tauri::command]
pub(super) async fn write_compiled_cache_chunk(
    state: State<'_, AppState>,
    bytes: Value,
    reset: bool,
    complete: bool,
) -> Result<(), String> {
    let bytes = decode_ipc_bytes(bytes)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_compiled_cache_chunk_inner(&state, &bytes, reset, complete)
    })
    .await
    .map_err(|error| format!("frontend background task failed: {error}"))?
}

pub(super) fn write_compiled_cache_chunk_inner(
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
        let target = directory.join("compiled-project.reracache");
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
    )?;
    if complete {
        let root = state
            .project
            .lock()
            .map_err(lock_error)?
            .as_ref()
            .ok_or_else(|| "no project is open".to_owned())?
            .root()
            .to_owned();
        let _ = fs::remove_file(root.join(".rustyera/cache/compiled-project.reraproj"));
    }
    Ok(())
}

#[tauri::command]
pub(super) fn cancel_compiled_cache_export(state: State<'_, AppState>) -> Result<(), String> {
    cancel_compiled_cache_export_inner(&state)
}

pub(super) fn cancel_compiled_cache_export_inner(state: &AppState) -> Result<(), String> {
    state.cache_writer.lock().map_err(lock_error)?.take();
    Ok(())
}

pub(super) fn write_atomic_file_chunk(
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

pub(super) fn append_atomic_file_chunk(
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
pub(super) fn read_import(path: PathBuf) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("cannot read import file: {error}"))
}
