use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::mem::size_of;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FrontendIoError, StorageEntry, StorageMetadata, StorageNamespace, StorageOperation,
    StoragePrecondition, StorageRequest, StorageResponse, StorageResult,
};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use tauri::ipc::Response;

mod listing;
#[cfg(any(test, feature = "webdriver"))]
mod observation;
pub(crate) mod path;

use path::{
    ResolvedReadPath, change_token, conflict, ensure_inside, exists_checked, frontend_error,
    invalid_path, resolve, resolve_normalized, resolve_normalized_with_presence, revision,
    validate_read_path,
};

pub struct StorageHost {
    project_root: PathBuf,
    data_root: PathBuf,
    save_root: PathBuf,
    allow_root_read_fallback: bool,
    normalize_data_paths: bool,
    profile: era_runtime_protocol::CompatibilityProfileId,
    idempotent: BTreeMap<String, CachedStorageResult>,
    idempotent_order: VecDeque<String>,
    idempotent_bytes: usize,
}

struct CachedStorageResult {
    result: StorageResult,
    retained_bytes: usize,
}

const MAXIMUM_IDEMPOTENT_RESULTS: usize = 1_024;
const MAXIMUM_IDEMPOTENT_BYTES: usize = 256 * 1024;
pub(crate) const MAXIMUM_RELATIVE_PATH_BYTES: usize = 4 * 1024;
pub(crate) const MAXIMUM_FULL_READ_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAXIMUM_RANGE_READ_BYTES: u32 = 4 * 1024 * 1024;
const MAXIMUM_LIST_ENTRIES: usize = 100_000;
const MAXIMUM_LIST_PATH_BYTES: usize = 8 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 64 * 1024;
const IPC_BYTES_TAG: &str = "$rustyeraBytes";
const IPC_INTEGER_TAG: &str = "$rustyeraInteger";
const MAXIMUM_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
struct StorageRequestWire {
    request_id: u64,
    namespace: StorageNamespace,
    relative_path: String,
    operation: StorageOperationWire,
    idempotency_key: String,
    deadline_ns: Option<u64>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StorageOperationWire {
    Read,
    Write {
        data: Value,
        atomic_replace: bool,
        precondition: StoragePrecondition,
    },
    List {
        pattern: Option<String>,
        recursive: bool,
    },
    Delete {
        precondition: StoragePrecondition,
    },
    Stat,
    ReadRange {
        offset: u64,
        maximum_bytes: u32,
        change_token: Option<String>,
    },
}

pub(crate) fn decode_request(value: Value) -> Result<StorageRequest, String> {
    let wire = crate::ipc::decode_value::<StorageRequestWire>(value)?;
    let operation = match wire.operation {
        StorageOperationWire::Read => StorageOperation::Read,
        StorageOperationWire::Write {
            data,
            atomic_replace,
            precondition,
        } => StorageOperation::Write {
            data: ProtocolBytes::new(decode_storage_bytes(data)?),
            atomic_replace,
            precondition,
        },
        StorageOperationWire::List { pattern, recursive } => {
            StorageOperation::List { pattern, recursive }
        }
        StorageOperationWire::Delete { precondition } => StorageOperation::Delete { precondition },
        StorageOperationWire::Stat => StorageOperation::Stat,
        StorageOperationWire::ReadRange {
            offset,
            maximum_bytes,
            change_token,
        } => StorageOperation::ReadRange {
            offset,
            maximum_bytes,
            change_token,
        },
    };
    Ok(StorageRequest {
        request_id: wire.request_id,
        namespace: wire.namespace,
        relative_path: wire.relative_path,
        operation,
        idempotency_key: wire.idempotency_key,
        deadline_ns: wire.deadline_ns,
    })
}

fn decode_storage_bytes(value: Value) -> Result<Vec<u8>, String> {
    let encoded = value
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get(IPC_BYTES_TAG))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "storage write data must use the tagged IPC bytes representation".to_owned()
        })?;
    let maximum_encoded = MAXIMUM_FULL_READ_BYTES.div_ceil(3) * 4;
    if encoded.len() > maximum_encoded {
        return Err("storage write data exceeds the native host memory budget".to_owned());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("cannot decode storage IPC bytes: {error}"))?;
    if bytes.len() > MAXIMUM_FULL_READ_BYTES {
        return Err("storage write data exceeds the native host memory budget".to_owned());
    }
    Ok(bytes)
}

pub(crate) fn encode_response(response: &StorageResponse) -> Result<Response, String> {
    serde_json::to_vec(&SafeStorageResponse(response))
        .map(Response::new)
        .map_err(|error| format!("cannot encode storage IPC response: {error}"))
}

impl StorageHost {
    #[cfg(test)]
    pub fn new(project_root: PathBuf) -> Self {
        Self::with_data_root(
            project_root.clone(),
            project_root,
            era_runtime_protocol::CompatibilityProfileId::EmueraEm,
        )
    }

    #[cfg(test)]
    pub fn with_data_root(
        project_root: PathBuf,
        data_root: PathBuf,
        profile: era_runtime_protocol::CompatibilityProfileId,
    ) -> Self {
        Self::with_storage_roots(project_root, data_root.clone(), data_root, profile)
    }

    pub fn with_storage_roots(
        project_root: PathBuf,
        data_root: PathBuf,
        save_root: PathBuf,
        profile: era_runtime_protocol::CompatibilityProfileId,
    ) -> Self {
        Self {
            project_root,
            data_root,
            save_root,
            allow_root_read_fallback: profile
                == era_runtime_protocol::CompatibilityProfileId::EmueraEm,
            normalize_data_paths: profile
                == era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
            profile,
            idempotent: BTreeMap::new(),
            idempotent_order: VecDeque::new(),
            idempotent_bytes: 0,
        }
    }

    pub fn list_traditional_save_slots(
        &self,
        slot_count: u32,
    ) -> Result<Vec<TraditionalSaveSlot>, String> {
        let directory = self.save_root.join("sav");
        let mut slots = (0..slot_count)
            .map(|slot| TraditionalSaveSlot {
                slot,
                occupied: false,
            })
            .collect::<Vec<_>>();
        match fs::symlink_metadata(&directory) {
            Ok(_) => ensure_inside(&self.save_root, &directory)
                .map_err(|error| format!("cannot list traditional saves: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(slots),
            Err(error) => {
                return Err(format!(
                    "cannot inspect traditional save directory: {error}"
                ));
            }
        }
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("cannot list traditional saves: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("cannot list traditional saves: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("cannot inspect traditional save entry: {error}"))?
                .is_file()
            {
                continue;
            }
            let Some(slot) = traditional_save_slot(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            if let Some(item) = slots.get_mut(slot as usize) {
                item.occupied = true;
            }
        }
        Ok(slots)
    }

    pub fn read_traditional_save(&self, slot: u32) -> Result<Vec<u8>, String> {
        let relative = traditional_save_name(slot)?;
        let resolved = self
            .resolve_for_read(StorageNamespace::Save, &relative)
            .map_err(|error| format!("cannot resolve traditional save: {error}"))?;
        if !resolved.existed {
            return Err("traditional save does not exist".into());
        }
        fs::read(resolved.path).map_err(|error| format!("cannot read traditional save: {error}"))
    }

    pub fn write_traditional_save(&self, slot: u32, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAXIMUM_FULL_READ_BYTES {
            return Err("traditional save exceeds the native host memory budget".into());
        }
        let target = self.traditional_save_path(slot)?;
        let directory = target
            .parent()
            .ok_or_else(|| "traditional save path has no parent".to_owned())?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("cannot create traditional save directory: {error}"))?;
        ensure_inside(&self.save_root, directory)
            .map_err(|error| format!("cannot resolve traditional save directory: {error}"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|error| format!("cannot create temporary traditional save: {error}"))?;
        std::io::Write::write_all(&mut temporary, bytes)
            .map_err(|error| format!("cannot write traditional save: {error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("cannot sync traditional save: {error}"))?;
        temporary
            .persist(target)
            .map_err(|error| format!("cannot replace traditional save: {}", error.error))?;
        Ok(())
    }

    fn traditional_save_path(&self, slot: u32) -> Result<PathBuf, String> {
        Ok(self
            .save_root
            .join("sav")
            .join(traditional_save_name(slot)?))
    }

    #[cfg(test)]
    pub fn handle(&mut self, request: StorageRequest) -> StorageResponse {
        self.handle_with_project(request, None)
    }

    pub fn handle_with_project(
        &mut self,
        request: StorageRequest,
        project: Option<&crate::project::ProjectHost>,
    ) -> StorageResponse {
        #[cfg(any(test, feature = "webdriver"))]
        let observation =
            observation::Pending::begin(&request, &self.project_root, &self.save_root);
        let response = self.handle_project_request(request, project);
        #[cfg(any(test, feature = "webdriver"))]
        if let Some(observation) = observation {
            observation.finish(&response);
        }
        response
    }

    fn handle_project_request(
        &mut self,
        request: StorageRequest,
        project: Option<&crate::project::ProjectHost>,
    ) -> StorageResponse {
        if request.namespace == StorageNamespace::Resource {
            let result = if matches!(
                request.operation,
                StorageOperation::Write { .. } | StorageOperation::Delete { .. }
            ) {
                StorageResult::Error {
                    error: FrontendIoError {
                        kind: era_runtime_protocol::FrontendIoErrorKind::ReadOnly,
                        message: "Resource storage is read-only".into(),
                        platform_code: None,
                    },
                }
            } else {
                project
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "no active resource manifest",
                        )
                    })
                    .and_then(|project| {
                        project.resource_storage(
                            &request.relative_path,
                            request.operation,
                            self.profile,
                        )
                    })
                    .unwrap_or_else(|error| StorageResult::Error {
                        error: frontend_error(&error),
                    })
            };
            return StorageResponse {
                request_id: request.request_id,
                result,
            };
        }
        if request.idempotency_key.len() > MAXIMUM_RELATIVE_PATH_BYTES {
            return StorageResponse {
                request_id: request.request_id,
                result: StorageResult::Error {
                    error: frontend_error(&budget_exceeded("storage idempotency key")),
                },
            };
        }
        if !request.idempotency_key.is_empty()
            && let Some(cached) = self.idempotent.get(&request.idempotency_key)
        {
            return StorageResponse {
                request_id: request.request_id,
                result: cached.result.clone(),
            };
        }
        let caches_result = matches!(
            request.operation,
            StorageOperation::Write { .. } | StorageOperation::Delete { .. }
        );
        let result = self
            .operate(request.namespace, &request.relative_path, request.operation)
            .unwrap_or_else(|error| StorageResult::Error {
                error: frontend_error(&error),
            });
        if caches_result && !request.idempotency_key.is_empty() {
            self.cache_idempotent(request.idempotency_key, result.clone());
        }
        StorageResponse {
            request_id: request.request_id,
            result,
        }
    }

    fn cache_idempotent(&mut self, key: String, result: StorageResult) {
        let retained_bytes = key.len().saturating_add(estimated_result_bytes(&result));
        if retained_bytes > MAXIMUM_IDEMPOTENT_BYTES {
            return;
        }
        while self.idempotent.len() >= MAXIMUM_IDEMPOTENT_RESULTS
            || self.idempotent_bytes.saturating_add(retained_bytes) > MAXIMUM_IDEMPOTENT_BYTES
        {
            let Some(oldest) = self.idempotent_order.pop_front() else {
                break;
            };
            if let Some(removed) = self.idempotent.remove(&oldest) {
                self.idempotent_bytes =
                    self.idempotent_bytes.saturating_sub(removed.retained_bytes);
            }
        }
        self.idempotent_bytes = self.idempotent_bytes.saturating_add(retained_bytes);
        self.idempotent_order.push_back(key.clone());
        self.idempotent.insert(
            key,
            CachedStorageResult {
                result,
                retained_bytes,
            },
        );
    }

    #[allow(
        clippy::too_many_lines,
        reason = "the exhaustive storage protocol dispatch is clearer in one match"
    )]
    fn operate(
        &self,
        namespace: StorageNamespace,
        relative_path: &str,
        operation: StorageOperation,
    ) -> Result<StorageResult, std::io::Error> {
        if relative_path.len() > MAXIMUM_RELATIVE_PATH_BYTES {
            return Err(budget_exceeded("storage relative path"));
        }
        let resolved = if matches!(
            &operation,
            StorageOperation::Read
                | StorageOperation::List { .. }
                | StorageOperation::Stat
                | StorageOperation::ReadRange { .. }
        ) {
            self.resolve_for_read(namespace, relative_path)?
        } else {
            let root = self.namespace_root(namespace);
            let path = self.resolve_namespace_path(namespace, &root, relative_path)?;
            ResolvedReadPath {
                root,
                path,
                existed: false,
            }
        };
        let root = resolved.root.as_path();
        let path = resolved.path.as_path();
        match operation {
            StorageOperation::Read => {
                let (data, revision) = read_bounded_with_revision(path)?;
                Ok(StorageResult::Read {
                    data: ProtocolBytes::new(data),
                    revision: Some(revision),
                })
            }
            StorageOperation::Write {
                data,
                atomic_replace,
                precondition,
            } => {
                verify_precondition_bounded(path, &precondition)?;
                let parent = path.parent().ok_or_else(invalid_path)?;
                fs::create_dir_all(parent)?;
                ensure_inside(root, parent)?;
                if atomic_replace {
                    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                    temporary.write_all(data.as_slice())?;
                    temporary.as_file().sync_all()?;
                    temporary.persist(path).map_err(|error| error.error)?;
                } else {
                    fs::write(path, data.as_slice())?;
                }
                Ok(StorageResult::Written {
                    revision: Some(revision(data.as_slice())),
                })
            }
            StorageOperation::List { pattern, recursive } => listing::list_storage(
                &resolved,
                pattern.as_deref(),
                recursive,
                self.normalize_data_paths && namespace == StorageNamespace::Data,
            ),
            StorageOperation::Delete { precondition } => {
                verify_precondition_bounded(path, &precondition)?;
                fs::remove_file(path)?;
                Ok(StorageResult::Deleted)
            }
            StorageOperation::Stat => {
                let (byte_length, revision) = stream_revision(path)?;
                Ok(StorageResult::Metadata(StorageMetadata {
                    byte_length,
                    revision: Some(revision),
                }))
            }
            StorageOperation::ReadRange {
                offset,
                maximum_bytes,
                change_token: expected,
            } => {
                if maximum_bytes == 0 || maximum_bytes > MAXIMUM_RANGE_READ_BYTES {
                    return Err(budget_exceeded("storage range read"));
                }
                let before = fs::metadata(path)?;
                let token = change_token(&before);
                if expected.as_ref().is_some_and(|value| value != &token) {
                    return Err(conflict("storage file changed before range read"));
                }
                let mut file = File::open(path)?;
                file.seek(SeekFrom::Start(offset))?;
                let mut data = vec![0; maximum_bytes as usize];
                let length = file.read(&mut data)?;
                data.truncate(length);
                let after = fs::metadata(path)?;
                if token != change_token(&after) {
                    return Err(conflict("storage file changed during range read"));
                }
                Ok(StorageResult::ReadChunk {
                    data: ProtocolBytes::new(data),
                    offset,
                    complete: offset.saturating_add(length as u64) >= after.len(),
                    change_token: token,
                })
            }
        }
    }

    fn namespace_root(&self, namespace: StorageNamespace) -> PathBuf {
        match namespace {
            StorageNamespace::Project => self.data_root.join("project"),
            // Emuera stores normal slots and global.sav in the project's sav directory.
            StorageNamespace::Save | StorageNamespace::GlobalSave => self.save_root.join("sav"),
            StorageNamespace::Data => self.data_root.join("data"),
            StorageNamespace::Log => self.data_root.join("logs"),
            StorageNamespace::Resource => self.project_root.clone(),
        }
    }

    fn resolve_namespace_path(
        &self,
        namespace: StorageNamespace,
        root: &Path,
        relative: &str,
    ) -> Result<PathBuf, std::io::Error> {
        if self.normalize_data_paths && namespace == StorageNamespace::Data {
            resolve_normalized(root, relative)
        } else {
            resolve(root, relative)
        }
    }

    fn resolve_for_read(
        &self,
        namespace: StorageNamespace,
        relative_path: &str,
    ) -> Result<ResolvedReadPath, std::io::Error> {
        let root = self.namespace_root(namespace);
        let (primary, existed) = if self.normalize_data_paths && namespace == StorageNamespace::Data
        {
            resolve_normalized_with_presence(&root, relative_path)?
        } else {
            let path = resolve(&root, relative_path)?;
            let existed = exists_checked(&root, &path)?;
            (path, existed)
        };
        if self.allow_root_read_fallback
            && matches!(
                namespace,
                StorageNamespace::Project | StorageNamespace::Data
            )
            && !existed
        {
            let path = resolve(&self.project_root, relative_path)?;
            let existed = exists_checked(&self.project_root, &path)?;
            return validate_read_path(&self.project_root, path, existed);
        }
        validate_read_path(&root, primary, existed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraditionalSaveSlot {
    pub slot: u32,
    pub occupied: bool,
}

fn traditional_save_slot(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let digits = lower.strip_prefix("save")?.strip_suffix(".sav")?;
    (digits.len() == 2 && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

fn traditional_save_name(slot: u32) -> Result<String, String> {
    if slot > 99 {
        return Err("traditional save slot must be between 00 and 99".into());
    }
    Ok(format!("save{slot:02}.sav"))
}

pub(crate) fn budget_exceeded(subject: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("{subject} exceeds the native host memory budget"),
    )
}

pub(crate) fn account_list_entry(
    entry_count: usize,
    retained_path_bytes: &mut usize,
    path_bytes: usize,
) -> Result<(), std::io::Error> {
    *retained_path_bytes = (*retained_path_bytes).saturating_add(path_bytes);
    if entry_count >= MAXIMUM_LIST_ENTRIES || *retained_path_bytes > MAXIMUM_LIST_PATH_BYTES {
        Err(budget_exceeded("storage directory listing"))
    } else {
        Ok(())
    }
}

fn read_bounded_with_revision(path: &Path) -> Result<(Vec<u8>, String), std::io::Error> {
    let announced = fs::metadata(path)?.len();
    if announced > MAXIMUM_FULL_READ_BYTES as u64 {
        return Err(budget_exceeded("storage full read"));
    }
    let capacity = usize::try_from(announced).unwrap_or(MAXIMUM_FULL_READ_BYTES);
    let mut data = Vec::with_capacity(capacity);
    File::open(path)?
        .take((MAXIMUM_FULL_READ_BYTES as u64).saturating_add(1))
        .read_to_end(&mut data)?;
    if data.len() > MAXIMUM_FULL_READ_BYTES {
        return Err(budget_exceeded("storage full read"));
    }
    let digest = revision(&data);
    Ok((data, digest))
}

fn stream_revision(path: &Path) -> Result<(u64, String), std::io::Error> {
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    let token = change_token(&before);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut byte_length = 0_u64;
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hasher.update(&buffer[..length]);
        byte_length = byte_length.saturating_add(length as u64);
    }
    let after = file.metadata()?;
    if token != change_token(&after) || byte_length != after.len() {
        return Err(conflict("storage file changed while hashing metadata"));
    }
    Ok((byte_length, hasher.finalize().to_hex().to_string()))
}

fn verify_precondition_bounded(
    path: &Path,
    precondition: &StoragePrecondition,
) -> Result<(), std::io::Error> {
    match precondition {
        StoragePrecondition::Any => Ok(()),
        StoragePrecondition::Missing if !path.try_exists()? => Ok(()),
        StoragePrecondition::Missing => Err(conflict("storage precondition did not hold")),
        StoragePrecondition::Revision(expected) => {
            let (_, current) = stream_revision(path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    conflict("storage precondition did not hold")
                } else {
                    error
                }
            })?;
            if &current == expected {
                Ok(())
            } else {
                Err(conflict("storage precondition did not hold"))
            }
        }
    }
}

fn estimated_result_bytes(result: &StorageResult) -> usize {
    let string = |value: &str| size_of::<String>().saturating_add(value.len());
    let optional_string = |value: &Option<String>| {
        size_of::<Option<String>>().saturating_add(value.as_deref().map_or(0, string))
    };
    let payload = match result {
        StorageResult::Read { data, revision } => data
            .as_slice()
            .len()
            .saturating_add(optional_string(revision)),
        StorageResult::Written { revision } => optional_string(revision),
        StorageResult::Listed { entries } => entries.iter().fold(
            entries.capacity().saturating_mul(size_of::<StorageEntry>()),
            |total, entry| {
                total
                    .saturating_add(entry.relative_path.len())
                    .saturating_add(optional_string(&entry.revision))
                    .saturating_add(optional_string(&entry.change_token))
            },
        ),
        StorageResult::Deleted => 0,
        StorageResult::Error { error } => error
            .message
            .len()
            .saturating_add(size_of::<FrontendIoError>()),
        StorageResult::Metadata(metadata) => optional_string(&metadata.revision),
        StorageResult::ReadChunk {
            data, change_token, ..
        } => data.as_slice().len().saturating_add(string(change_token)),
    };
    size_of::<StorageResult>().saturating_add(payload)
}

struct SafeStorageResponse<'a>(&'a StorageResponse);

impl Serialize for SafeStorageResponse<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("request_id", &SafeU64(self.0.request_id))?;
        map.serialize_entry("result", &SafeStorageResult(&self.0.result))?;
        map.end()
    }
}

struct SafeStorageResult<'a>(&'a StorageResult);

impl Serialize for SafeStorageResult<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        match self.0 {
            StorageResult::Read { data, revision } => {
                map.serialize_entry("type", "read")?;
                map.serialize_entry("data", &SafeBytes(data.as_slice()))?;
                map.serialize_entry("revision", revision)?;
            }
            StorageResult::Written { revision } => {
                map.serialize_entry("type", "written")?;
                map.serialize_entry("revision", revision)?;
            }
            StorageResult::Listed { entries } => {
                map.serialize_entry("type", "listed")?;
                map.serialize_entry("entries", &SafeStorageEntries(entries))?;
            }
            StorageResult::Deleted => map.serialize_entry("type", "deleted")?,
            StorageResult::Error { error } => {
                map.serialize_entry("type", "error")?;
                map.serialize_entry("error", &SafeFrontendIoError(error))?;
            }
            StorageResult::Metadata(metadata) => {
                map.serialize_entry("type", "metadata")?;
                map.serialize_entry("byte_length", &SafeU64(metadata.byte_length))?;
                map.serialize_entry("revision", &metadata.revision)?;
            }
            StorageResult::ReadChunk {
                data,
                offset,
                complete,
                change_token,
            } => {
                map.serialize_entry("type", "read_chunk")?;
                map.serialize_entry("data", &SafeBytes(data.as_slice()))?;
                map.serialize_entry("offset", &SafeU64(*offset))?;
                map.serialize_entry("complete", complete)?;
                map.serialize_entry("change_token", change_token)?;
            }
        }
        map.end()
    }
}

struct SafeStorageEntries<'a>(&'a [StorageEntry]);

impl Serialize for SafeStorageEntries<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for entry in self.0 {
            sequence.serialize_element(&SafeStorageEntry(entry))?;
        }
        sequence.end()
    }
}

struct SafeStorageEntry<'a>(&'a StorageEntry);

impl Serialize for SafeStorageEntry<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("relative_path", &self.0.relative_path)?;
        map.serialize_entry("byte_length", &SafeU64(self.0.byte_length))?;
        map.serialize_entry("revision", &self.0.revision)?;
        map.serialize_entry("change_token", &self.0.change_token)?;
        map.end()
    }
}

struct SafeFrontendIoError<'a>(&'a FrontendIoError);

impl Serialize for SafeFrontendIoError<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("kind", &self.0.kind)?;
        map.serialize_entry("message", &self.0.message)?;
        map.serialize_entry("platform_code", &self.0.platform_code.map(SafeI64))?;
        map.end()
    }
}

struct SafeBytes<'a>(&'a [u8]);

impl Serialize for SafeBytes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = base64::engine::general_purpose::STANDARD.encode(self.0);
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(IPC_BYTES_TAG, &encoded)?;
        map.end()
    }
}

struct SafeU64(u64);

impl Serialize for SafeU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.0 <= MAXIMUM_SAFE_JAVASCRIPT_INTEGER {
            serializer.serialize_u64(self.0)
        } else {
            serialize_tagged_integer(serializer, &self.0.to_string())
        }
    }
}

struct SafeI64(i64);

impl Serialize for SafeI64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.0.unsigned_abs() <= MAXIMUM_SAFE_JAVASCRIPT_INTEGER {
            serializer.serialize_i64(self.0)
        } else {
            serialize_tagged_integer(serializer, &self.0.to_string())
        }
    }
}

fn serialize_tagged_integer<S>(serializer: S, value: &str) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut map = serializer.serialize_map(Some(1))?;
    map.serialize_entry(IPC_INTEGER_TAG, value)?;
    map.end()
}

#[cfg(test)]
mod tests;
