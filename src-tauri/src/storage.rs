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
        if slot > 99 {
            return Err("traditional save slot must be between 00 and 99".into());
        }
        let relative = format!("save{slot:02}.sav");
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
        if slot > 99 {
            return Err("traditional save slot must be between 00 and 99".into());
        }
        Ok(self
            .save_root
            .join("sav")
            .join(format!("save{slot:02}.sav")))
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
mod tests {
    use super::*;
    use era_runtime_protocol::{FrontendIoErrorKind, StoragePrecondition};

    fn resource_request(path: &str, operation: StorageOperation) -> StorageRequest {
        StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Resource,
            relative_path: path.into(),
            operation,
            idempotency_key: String::new(),
            deadline_ns: None,
        }
    }

    fn data_request(path: &str, operation: StorageOperation) -> StorageRequest {
        StorageRequest {
            namespace: StorageNamespace::Data,
            ..resource_request(path, operation)
        }
    }

    #[test]
    fn snake_data_normalized_paths_agree_with_resource_identity_and_mutate_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("plugins/café")).unwrap();
        fs::write(root.join("plugins/café/seed.txt"), b"source").unwrap();
        let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let private = root.join("private");
        let data = private.join("data");
        let actual = data.join("PlUgIns/Cafe\u{301}/SEED.TXT");
        fs::create_dir_all(actual.parent().unwrap()).unwrap();
        fs::write(&actual, b"overlay").unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            private,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        for name in ["plugins/CAFÉ/seed.txt", "PLUGINS/cafe\u{301}/SEED.TXT"] {
            assert!(
                matches!(host.handle(data_request(name, StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
            );
            assert!(matches!(
                host.handle(data_request(name, StorageOperation::Stat))
                    .result,
                StorageResult::Metadata(StorageMetadata { byte_length: 7, .. })
            ));
            assert!(
                matches!(host.handle(data_request(name, StorageOperation::ReadRange { offset: 1, maximum_bytes: 3, change_token: None })).result, StorageResult::ReadChunk { data, .. } if data.as_slice() == b"ver")
            );
        }
        let listed = host
            .handle(data_request(
                "pLuGiNs",
                StorageOperation::List {
                    pattern: None,
                    recursive: true,
                },
            ))
            .result;
        let StorageResult::Listed { entries } = listed else {
            panic!("expected normalized Data listing")
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["PlUgIns/Café/SEED.TXT"]
        );
        assert!(
            matches!(host.handle(data_request(&entries[0].relative_path, StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
        );
        assert!(
            matches!(host.handle_with_project(resource_request("PLUGINS/café/seed.txt", StorageOperation::Read), Some(&project)).result, StorageResult::Read { data, .. } if data.as_slice() == b"source")
        );
        let written = host
            .handle(data_request(
                "plugins/CAFÉ/Seed.Txt",
                StorageOperation::Write {
                    data: ProtocolBytes::new(b"changed".to_vec()),
                    atomic_replace: true,
                    precondition: StoragePrecondition::Any,
                },
            ))
            .result;
        assert!(matches!(written, StorageResult::Written { .. }));
        assert_eq!(fs::read(&actual).unwrap(), b"changed");
        assert_eq!(fs::read_dir(actual.parent().unwrap()).unwrap().count(), 1);
        assert!(matches!(
            host.handle(data_request(
                "New/e\u{301}.txt",
                StorageOperation::Write {
                    data: ProtocolBytes::new(b"new".to_vec()),
                    atomic_replace: false,
                    precondition: StoragePrecondition::Any
                }
            ))
            .result,
            StorageResult::Written { .. }
        ));
        assert!(
            matches!(host.handle(data_request("new/É.TXT", StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"new")
        );
        assert!(matches!(
            host.handle(data_request(
                "PLUGINS/café/seed.txt",
                StorageOperation::Delete {
                    precondition: StoragePrecondition::Any
                }
            ))
            .result,
            StorageResult::Deleted
        ));
        assert!(!actual.exists());
        assert!(
            matches!(host.handle(data_request("plugins/café/seed.txt", StorageOperation::Read)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::NotFound)
        );
        assert_eq!(
            fs::read(root.join("plugins/café/seed.txt")).unwrap(),
            b"source"
        );
    }

    #[cfg(unix)]
    #[test]
    fn snake_data_normalized_lookup_rejects_links_and_oversized_paths_before_writes() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let private = root.join("private");
        let data = private.join("data");
        fs::create_dir_all(&data).unwrap();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("seed.txt"), b"private").unwrap();
        symlink(&outside, data.join("Escape")).unwrap();
        symlink(&data, data.join("Loop")).unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            private,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        for (name, kind) in [
            (
                "escape/seed.txt".into(),
                FrontendIoErrorKind::PermissionDenied,
            ),
            ("loop/seed.txt".into(), FrontendIoErrorKind::InvalidData),
            ("a".repeat(4097), FrontendIoErrorKind::InvalidData),
            (vec!["a"; 257].join("/"), FrontendIoErrorKind::InvalidData),
        ] {
            for operation in [
                StorageOperation::Read,
                StorageOperation::Stat,
                StorageOperation::Delete {
                    precondition: StoragePrecondition::Any,
                },
                StorageOperation::Write {
                    data: ProtocolBytes::new(b"bad".to_vec()),
                    atomic_replace: false,
                    precondition: StoragePrecondition::Any,
                },
            ] {
                let result = host.handle(data_request(&name, operation)).result;
                assert!(matches!(result, StorageResult::Error { error } if error.kind == kind));
            }
        }
        assert_eq!(fs::read(outside.join("seed.txt")).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn snake_data_namespace_link_does_not_reauthorize_an_outside_root() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let private = root.join("private");
        let outside = root.join("outside");
        fs::create_dir(&private).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("seed.txt"), b"safe").unwrap();
        symlink(&outside, private.join("data")).unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            private,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        for operation in [
            StorageOperation::Read,
            StorageOperation::Write {
                data: ProtocolBytes::new(b"bad".to_vec()),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            },
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ] {
            let name = if matches!(operation, StorageOperation::List { .. }) {
                ""
            } else {
                "seed.txt"
            };
            assert!(
                matches!(host.handle(data_request(name, operation)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
            );
        }
        assert_eq!(fs::read(outside.join("seed.txt")).unwrap(), b"safe");
    }

    #[cfg(unix)]
    #[test]
    fn storage_list_keeps_safe_alias_scope_and_original_does_not_follow_alias_subtrees() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let data = root.join("data");
        fs::create_dir_all(data.join("real")).unwrap();
        fs::write(data.join("real/A.txt"), b"alias contents").unwrap();
        symlink(data.join("real"), data.join("AliAs")).unwrap();
        let mut snake = StorageHost::with_data_root(
            root.to_owned(),
            root.to_owned(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        let StorageResult::Listed { entries } = snake
            .handle(data_request(
                "ALIAS",
                StorageOperation::List {
                    pattern: None,
                    recursive: true,
                },
            ))
            .result
        else {
            panic!("expected alias listing");
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["AliAs/A.txt"]
        );
        assert!(
            matches!(snake.handle(data_request("alias/a.TXT", StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"alias contents")
        );
        assert!(matches!(
            snake
                .handle(data_request("alias/a.TXT", StorageOperation::Stat))
                .result,
            StorageResult::Metadata(StorageMetadata {
                byte_length: 14,
                ..
            })
        ));
        let mut original = StorageHost::new(root.to_owned());
        let StorageResult::Listed { entries } = original
            .handle(data_request(
                "",
                StorageOperation::List {
                    pattern: None,
                    recursive: true,
                },
            ))
            .result
        else {
            panic!("expected original listing");
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["real/A.txt"]
        );
    }

    #[test]
    fn storage_list_rejects_target_disappeared_between_lookup_and_walk() {
        for profile in [
            era_runtime_protocol::CompatibilityProfileId::EmueraEm,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let target = root.join("data/MiXeD");
            fs::create_dir_all(&target).unwrap();
            fs::create_dir(root.join("MiXeD")).unwrap();
            fs::write(root.join("MiXeD/fallback.txt"), b"must not fall back").unwrap();
            let host = StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
            let snake = profile == era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake;
            let query = if snake { "mixed" } else { "MiXeD" };
            let resolved = host
                .resolve_for_read(StorageNamespace::Data, query)
                .unwrap();
            assert!(resolved.existed);
            fs::remove_dir(&target).unwrap();
            let error = listing::list_storage(&resolved, None, true, snake).unwrap_err();
            assert_eq!(frontend_error(&error).kind, FrontendIoErrorKind::Conflict);

            // Absence at the original lookup remains a successful empty list.
            let absent = host
                .resolve_for_read(StorageNamespace::Data, "absent")
                .unwrap();
            assert!(!absent.existed);
            assert!(
                matches!(listing::list_storage(&absent, None, true, snake).unwrap(), StorageResult::Listed { entries } if entries.is_empty())
            );
        }
    }

    #[test]
    fn original_storage_fallback_keeps_its_target_presence_until_walk() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("fallback");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("seed.txt"), b"fallback").unwrap();
        let host = StorageHost::new(root.to_owned());
        let resolved = host
            .resolve_for_read(StorageNamespace::Data, "fallback")
            .unwrap();
        assert!(
            matches!(listing::list_storage(&resolved, None, true, false).unwrap(), StorageResult::Listed { entries } if entries.len() == 1 && entries[0].relative_path == "fallback/seed.txt")
        );
        fs::remove_file(target.join("seed.txt")).unwrap();
        fs::remove_dir(&target).unwrap();
        let error = listing::list_storage(&resolved, None, true, false).unwrap_err();
        assert_eq!(frontend_error(&error).kind, FrontendIoErrorKind::Conflict);
    }

    #[cfg(unix)]
    #[test]
    fn storage_list_rejects_dangling_entries_without_partial_results_or_namespace_fallback() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("data")).unwrap();
        fs::write(root.join("fallback.txt"), b"fallback").unwrap();
        fs::write(root.join("data/good.txt"), b"good").unwrap();
        symlink(root.join("missing"), root.join("data/dangling")).unwrap();
        for profile in [
            era_runtime_protocol::CompatibilityProfileId::EmueraEm,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        ] {
            let mut host = StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
            assert!(
                matches!(host.handle(data_request("", StorageOperation::List { pattern: None, recursive: true })).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn storage_list_checks_actual_names_before_pattern_filtering_in_both_profiles() {
        for name in ["bad\\name.txt", "C:seed.txt"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            fs::create_dir_all(root.join("data/nested")).unwrap();
            fs::write(root.join("data/nested").join(name), b"invalid").unwrap();
            for profile in [
                era_runtime_protocol::CompatibilityProfileId::EmueraEm,
                era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
            ] {
                let mut host =
                    StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
                for path in ["", "nested"] {
                    assert!(
                        matches!(host.handle(data_request(path, StorageOperation::List { pattern: Some("*.xml".into()), recursive: true })).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
                    );
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn storage_list_preserves_permission_denied_from_an_opened_subdirectory() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let nested = root.join("data/nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("data/good.txt"), b"good").unwrap();
        let permissions = fs::metadata(&nested).unwrap().permissions();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o0)).unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            root.to_owned(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        let result = host
            .handle(data_request(
                "",
                StorageOperation::List {
                    pattern: None,
                    recursive: true,
                },
            ))
            .result;
        fs::set_permissions(&nested, permissions).unwrap();
        assert!(
            matches!(result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn snake_storage_lists_share_pattern_rules_between_data_and_resource() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("data")).unwrap();
        // Use an isolated directory per Unicode filename: macOS can normalize directory names.
        for name in ["SEED.TXT", "😀.txt", "é.txt", "[ab].txt", "a.txt"] {
            fs::write(root.join(name), b"source").unwrap();
            fs::write(root.join("data").join(name), b"overlay").unwrap();
        }
        let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            root.to_owned(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        for pattern in ["*.txt", "?.txt", "É.TXT", "[ab].txt", ""] {
            let operation = StorageOperation::List {
                pattern: Some(pattern.into()),
                recursive: true,
            };
            let StorageResult::Listed { entries: data } =
                host.handle(data_request("", operation.clone())).result
            else {
                panic!("expected Data listing");
            };
            let StorageResult::Listed { entries: resources } = host
                .handle_with_project(resource_request("", operation), Some(&project))
                .result
            else {
                panic!("expected Resource listing");
            };
            assert_eq!(
                data.iter()
                    .map(|entry| &entry.relative_path)
                    .collect::<Vec<_>>(),
                resources
                    .iter()
                    .map(|entry| &entry.relative_path)
                    .collect::<Vec<_>>(),
                "{pattern}"
            );
        }
    }

    #[test]
    fn resource_storage_authorizes_manifest_and_keeps_data_overlay_separate() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("plugins/nested")).unwrap();
        fs::write(root.join("plugins/a.xml"), b"source").unwrap();
        fs::write(root.join("plugins/nested/b.txt"), b"nested").unwrap();
        fs::write(root.join("main.erb"), b"@MAIN\nRETURN\n").unwrap();
        let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let mut host = StorageHost::with_data_root(
            root.to_owned(),
            root.join("private"),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        fs::create_dir_all(root.join("private/data/plugins")).unwrap();
        fs::write(root.join("private/data/plugins/a.xml"), b"overlay").unwrap();
        let read = host.handle_with_project(
            resource_request("PLUGINS/a.xml", StorageOperation::Read),
            Some(&project),
        );
        assert!(
            matches!(read.result, StorageResult::Read { data, .. } if data.as_slice() == b"source")
        );
        let mut overlay = resource_request("plugins/a.xml", StorageOperation::Read);
        overlay.namespace = StorageNamespace::Data;
        assert!(
            matches!(host.handle(overlay).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
        );
        let listed = host.handle_with_project(
            resource_request(
                "plugins",
                StorageOperation::List {
                    pattern: Some("*".into()),
                    recursive: true,
                },
            ),
            Some(&project),
        );
        let StorageResult::Listed { entries } = listed.result else {
            panic!("expected resource listing")
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["plugins/a.xml", "plugins/nested/b.txt"]
        );
        let chunk = host.handle_with_project(
            resource_request(
                "plugins/a.xml",
                StorageOperation::ReadRange {
                    offset: 2,
                    maximum_bytes: 3,
                    change_token: entries[0].change_token.clone(),
                },
            ),
            Some(&project),
        );
        assert!(
            matches!(chunk.result, StorageResult::ReadChunk { data, complete: false, .. } if data.as_slice() == b"urc")
        );
        let metadata = host.handle_with_project(
            resource_request("plugins/a.xml", StorageOperation::Stat),
            Some(&project),
        );
        assert!(matches!(
            metadata.result,
            StorageResult::Metadata(StorageMetadata {
                byte_length: 6,
                revision: Some(_)
            })
        ));
        for operation in [StorageOperation::Read, StorageOperation::Stat] {
            assert!(
                matches!(host.handle_with_project(resource_request("main.erb", operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
            );
        }
    }

    #[test]
    fn resource_storage_rejects_mutation_before_paths_or_cached_results() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut host = StorageHost::new(root.to_owned());
        host.cache_idempotent("same".into(), StorageResult::Deleted);
        for operation in [
            StorageOperation::Write {
                data: ProtocolBytes::new(vec![1]),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            },
            StorageOperation::Delete {
                precondition: StoragePrecondition::Any,
            },
        ] {
            let mut request = resource_request("missing/sub/seed.xml", operation);
            request.idempotency_key = "same".into();
            assert!(
                matches!(host.handle(request).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::ReadOnly)
            );
        }
        assert!(!root.join("missing").exists());
    }

    #[test]
    fn resource_storage_detects_changes_and_rejects_invalid_ranges() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("seed.xml"), b"one").unwrap();
        let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let mut host = StorageHost::new(root.to_owned());
        for operation in [
            StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: 0,
                change_token: None,
            },
            StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: MAXIMUM_RANGE_READ_BYTES + 1,
                change_token: None,
            },
        ] {
            assert!(
                matches!(host.handle_with_project(resource_request("seed.xml", operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
            );
        }
        assert!(
            matches!(host.handle_with_project(resource_request("seed.xml", StorageOperation::ReadRange { offset: 0, maximum_bytes: 1, change_token: Some("old".into()) }), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
        );
        fs::write(root.join("seed.xml"), b"two").unwrap();
        for operation in [
            StorageOperation::Read,
            StorageOperation::Stat,
            StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: 1,
                change_token: None,
            },
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ] {
            let relative = if matches!(operation, StorageOperation::List { .. }) {
                ""
            } else {
                "seed.xml"
            };
            assert!(
                matches!(host.handle_with_project(resource_request(relative, operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn resource_storage_and_data_listing_reject_link_escape_and_cycles() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("game");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("seed.xml"), b"seed").unwrap();
        let project = crate::project::ProjectHost::scan_with_progress(&root, 1, None).unwrap();
        let mut host = StorageHost::new(root.clone());
        let outside = directory.path().join("outside.xml");
        fs::write(&outside, b"outside").unwrap();
        fs::remove_file(root.join("seed.xml")).unwrap();
        symlink(&outside, root.join("seed.xml")).unwrap();
        assert!(
            matches!(host.handle_with_project(resource_request("seed.xml", StorageOperation::Read), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
        );
        symlink(root.join("data"), root.join("data/loop")).unwrap();
        let mut request = resource_request(
            "",
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        );
        request.namespace = StorageNamespace::Data;
        assert!(
            matches!(host.handle(request.clone()).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
        );
        fs::remove_file(root.join("data/loop")).unwrap();
        symlink(&outside, root.join("data/out.xml")).unwrap();
        assert!(
            matches!(host.handle(request).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn traversal_is_rejected() {
        let root = Path::new("project");
        assert!(resolve(root, "../secret").is_err());
        assert!(resolve(root, "/secret").is_err());
    }

    #[test]
    fn idempotent_results_evict_oldest_entries_at_the_capacity_limit() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());
        for index in 0..=MAXIMUM_IDEMPOTENT_RESULTS {
            storage.cache_idempotent(format!("key-{index}"), StorageResult::Deleted);
        }

        assert_eq!(storage.idempotent.len(), MAXIMUM_IDEMPOTENT_RESULTS);
        assert!(!storage.idempotent.contains_key("key-0"));
        assert!(
            storage
                .idempotent
                .contains_key(&format!("key-{MAXIMUM_IDEMPOTENT_RESULTS}"))
        );
        assert!(storage.idempotent_bytes <= MAXIMUM_IDEMPOTENT_BYTES);
    }

    #[test]
    fn oversized_idempotent_results_are_not_cached() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());
        storage.cache_idempotent(
            "too-large".into(),
            StorageResult::Error {
                error: FrontendIoError {
                    kind: FrontendIoErrorKind::Other,
                    message: "x".repeat(MAXIMUM_IDEMPOTENT_BYTES),
                    platform_code: None,
                },
            },
        );

        assert!(storage.idempotent.is_empty());
        assert_eq!(storage.idempotent_bytes, 0);
    }

    #[test]
    fn storage_wire_tags_binary_data_and_unsafe_integers() {
        let request = decode_request(serde_json::json!({
            "request_id": { "$rustyeraInteger": "9007199254740992" },
            "namespace": "save",
            "relative_path": "save01.sav",
            "operation": {
                "type": "write",
                "data": { "$rustyeraBytes": "AID/" },
                "atomic_replace": true,
                "precondition": { "type": "any" }
            },
            "idempotency_key": "save-write",
            "deadline_ns": { "$rustyeraInteger": "9007199254740993" }
        }))
        .unwrap();
        assert_eq!(request.request_id, 9_007_199_254_740_992);
        assert_eq!(request.deadline_ns, Some(9_007_199_254_740_993));
        let StorageOperation::Write { data, .. } = request.operation else {
            panic!("expected decoded write operation");
        };
        assert_eq!(data.as_slice(), &[0, 0x80, 0xff]);
        assert!(
            decode_request(serde_json::json!({
                "request_id": 1,
                "namespace": "save",
                "relative_path": "save01.sav",
                "operation": {
                    "type": "write",
                    "data": [0, 128, 255],
                    "atomic_replace": true,
                    "precondition": { "type": "any" }
                },
                "idempotency_key": "save-write",
                "deadline_ns": null
            }))
            .is_err()
        );

        let encoded = serde_json::to_value(SafeStorageResponse(&StorageResponse {
            request_id: 9_007_199_254_740_992,
            result: StorageResult::ReadChunk {
                data: ProtocolBytes::new(vec![0, 0x80, 0xff]),
                offset: 9_007_199_254_740_993,
                complete: true,
                change_token: "token".into(),
            },
        }))
        .unwrap();
        assert_eq!(encoded["request_id"][IPC_INTEGER_TAG], "9007199254740992");
        assert_eq!(encoded["result"]["data"][IPC_BYTES_TAG], "AID/");
        assert_eq!(
            encoded["result"]["offset"][IPC_INTEGER_TAG],
            "9007199254740993"
        );
    }

    #[test]
    fn storage_reads_and_paths_are_rejected_before_unbounded_allocation() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("sav")).unwrap();
        let oversized = directory.path().join("sav/oversized.sav");
        File::create(&oversized)
            .unwrap()
            .set_len((MAXIMUM_FULL_READ_BYTES as u64) + 1)
            .unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());

        let full = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Save,
            relative_path: "oversized.sav".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        assert!(matches!(full.result, StorageResult::Error { .. }));

        let range = storage.handle(StorageRequest {
            request_id: 2,
            namespace: StorageNamespace::Save,
            relative_path: "oversized.sav".into(),
            operation: StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: MAXIMUM_RANGE_READ_BYTES + 1,
                change_token: None,
            },
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        assert!(matches!(range.result, StorageResult::Error { .. }));

        let path = storage.handle(StorageRequest {
            request_id: 3,
            namespace: StorageNamespace::Save,
            relative_path: "x".repeat(MAXIMUM_RELATIVE_PATH_BYTES + 1),
            operation: StorageOperation::Stat,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        assert!(matches!(path.result, StorageResult::Error { .. }));
    }

    #[test]
    fn storage_list_budget_limits_entry_count_and_retained_paths() {
        let mut retained_path_bytes = 0;
        assert!(account_list_entry(MAXIMUM_LIST_ENTRIES, &mut retained_path_bytes, 1).is_err());

        retained_path_bytes = MAXIMUM_LIST_PATH_BYTES;
        assert!(account_list_entry(0, &mut retained_path_bytes, 1).is_err());
    }

    #[test]
    fn stat_hashes_with_a_fixed_buffer() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("sav")).unwrap();
        fs::write(directory.path().join("sav/save01.sav"), b"save data").unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());

        let response = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Save,
            relative_path: "save01.sav".into(),
            operation: StorageOperation::Stat,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Metadata(metadata) = response.result else {
            panic!("expected storage metadata");
        };
        let expected_revision = revision(b"save data");
        assert_eq!(metadata.byte_length, 9);
        assert_eq!(
            metadata.revision.as_deref(),
            Some(expected_revision.as_str())
        );
    }

    #[test]
    fn snake_project_and_data_reads_never_fall_back_to_reference_sentinels() {
        for namespace in [StorageNamespace::Project, StorageNamespace::Data] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            fs::create_dir_all(root.join("shared")).unwrap();
            fs::write(root.join("shared/sentinel.xml"), b"reference sentinel").unwrap();
            let mut reference = StorageHost::new(root.to_owned());
            let mut snake = StorageHost::with_data_root(
                root.to_owned(),
                root.join(".rustyera/profiles/emuera.skia.snake"),
                era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
            );
            for operation in [
                StorageOperation::Read,
                StorageOperation::Stat,
                StorageOperation::ReadRange {
                    offset: 0,
                    maximum_bytes: 64,
                    change_token: None,
                },
                StorageOperation::List {
                    pattern: Some("sentinel.xml".into()),
                    recursive: false,
                },
            ] {
                let relative_path = if matches!(operation, StorageOperation::List { .. }) {
                    "shared"
                } else {
                    "shared/sentinel.xml"
                };
                let request = StorageRequest {
                    request_id: 1,
                    namespace,
                    relative_path: relative_path.into(),
                    operation,
                    idempotency_key: String::new(),
                    deadline_ns: None,
                };
                assert!(!matches!(
                    reference.handle(request.clone()).result,
                    StorageResult::Error { .. }
                ));
                let is_list = matches!(request.operation, StorageOperation::List { .. });
                let result = snake.handle(request).result;
                if is_list {
                    assert!(
                        matches!(result, StorageResult::Listed { entries } if entries.is_empty())
                    );
                } else {
                    assert!(matches!(result, StorageResult::Error { .. }));
                }
            }
            let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
            let request = StorageRequest {
                request_id: 2,
                namespace: StorageNamespace::Resource,
                relative_path: "shared/sentinel.xml".into(),
                operation: StorageOperation::Read,
                idempotency_key: String::new(),
                deadline_ns: None,
            };
            assert!(
                matches!(snake.handle_with_project(request, Some(&project)).result, StorageResult::Read { data, .. } if data.as_slice() == b"reference sentinel")
            );
        }
    }

    #[test]
    fn snake_profile_uses_project_saves_and_isolates_other_runtime_data() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let snake = root.join(".rustyera/profiles/emuera.skia.snake");
        fs::create_dir_all(root.join("sav")).unwrap();
        fs::create_dir_all(snake.join("sav")).unwrap();
        fs::write(root.join("sav/save00.sav"), b"reference").unwrap();
        fs::write(snake.join("sav/save00.sav"), b"snake").unwrap();
        let mut storage = StorageHost::with_storage_roots(
            root.to_owned(),
            snake.clone(),
            root.to_owned(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        assert_eq!(storage.namespace_root(StorageNamespace::Resource), root);
        assert_eq!(
            storage.namespace_root(StorageNamespace::GlobalSave),
            root.join("sav")
        );
        let response = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Save,
            relative_path: "save00.sav".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Read { data, .. } = response.result else {
            panic!("expected project save");
        };
        assert_eq!(data.as_slice(), b"reference");
        assert_eq!(fs::read(root.join("sav/save00.sav")).unwrap(), b"reference");
        assert_eq!(
            storage.namespace_root(StorageNamespace::Data),
            snake.join("data")
        );
    }

    #[test]
    fn traditional_save_management_routes_bytes_transparently_to_the_shared_save_root() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();
        let private = project.join(".rustyera/profiles/emuera.skia.snake");
        let storage = StorageHost::with_storage_roots(
            project.to_owned(),
            private,
            project.to_owned(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        storage
            .write_traditional_save(1, b"opaque core-validated bytes")
            .unwrap();
        assert_eq!(
            storage.read_traditional_save(1).unwrap(),
            b"opaque core-validated bytes"
        );
        let slots = storage.list_traditional_save_slots(3).unwrap();
        assert_eq!(
            slots,
            vec![
                TraditionalSaveSlot {
                    slot: 0,
                    occupied: false
                },
                TraditionalSaveSlot {
                    slot: 1,
                    occupied: true
                },
                TraditionalSaveSlot {
                    slot: 2,
                    occupied: false
                },
            ]
        );
        assert!(
            !project
                .join(".rustyera/profiles/emuera.skia.snake/sav")
                .exists()
        );
    }

    #[test]
    fn packaged_snake_project_separates_persistent_saves_from_private_data_and_logs() {
        let directory = tempfile::tempdir().unwrap();
        let resource_root = directory.path().join("package-source");
        let save_root = directory.path().join("packaged-projects/game-key");
        let data_root = save_root.join(".rustyera/profiles/emuera.skia.snake");
        fs::create_dir_all(&resource_root).unwrap();
        let mut storage = StorageHost::with_storage_roots(
            resource_root.clone(),
            data_root.clone(),
            save_root.clone(),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );

        storage
            .write_traditional_save(0, b"shared 1808 save")
            .unwrap();
        for (request_id, namespace, relative_path) in [
            (1, StorageNamespace::Data, "state.db"),
            (2, StorageNamespace::Log, "runtime.log"),
        ] {
            let response = storage.handle(StorageRequest {
                request_id,
                namespace,
                relative_path: relative_path.into(),
                operation: StorageOperation::Write {
                    data: ProtocolBytes::new(vec![u8::try_from(request_id).unwrap()]),
                    atomic_replace: true,
                    precondition: StoragePrecondition::Any,
                },
                idempotency_key: format!("packaged-{request_id}"),
                deadline_ns: None,
            });
            assert!(matches!(response.result, StorageResult::Written { .. }));
        }

        assert_eq!(
            fs::read(save_root.join("sav/save00.sav")).unwrap(),
            b"shared 1808 save"
        );
        assert_eq!(fs::read(data_root.join("data/state.db")).unwrap(), [1]);
        assert_eq!(fs::read(data_root.join("logs/runtime.log")).unwrap(), [2]);
        assert!(!resource_root.join("sav").exists());
        assert!(!save_root.join("data").exists());
        assert!(!save_root.join("logs").exists());
    }

    #[test]
    fn emuera_save_directory_is_used_for_slots_and_global_data() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("sav")).unwrap();
        fs::write(directory.path().join("sav/save01.sav"), b"slot").unwrap();
        fs::write(directory.path().join("sav/global.sav"), b"global").unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());

        let listed = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Save,
            relative_path: String::new(),
            operation: StorageOperation::List {
                pattern: Some("save*.sav".into()),
                recursive: false,
            },
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Listed { entries } = listed.result else {
            panic!("expected a save listing");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "save01.sav");

        let global = storage.handle(StorageRequest {
            request_id: 2,
            namespace: StorageNamespace::GlobalSave,
            relative_path: "global.sav".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Read { data, .. } = global.result else {
            panic!("expected global save data");
        };
        assert_eq!(data.as_slice(), b"global");
    }

    #[test]
    fn data_operations_use_emuera_root_fallback_and_private_overrides() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("XML")).unwrap();
        fs::write(directory.path().join("XML/SKILL_LIFE.xml"), b"<project />").unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());

        let response = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Data,
            relative_path: "XML/SKILL_LIFE.xml".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });

        let StorageResult::Read { data, .. } = response.result else {
            panic!("expected project-root text data");
        };
        assert_eq!(data.as_slice(), b"<project />");

        let listed = storage.handle(StorageRequest {
            request_id: 2,
            namespace: StorageNamespace::Data,
            relative_path: "XML".into(),
            operation: StorageOperation::List {
                pattern: Some("SKILL*.xml".into()),
                recursive: false,
            },
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Listed { entries } = listed.result else {
            panic!("expected project-root XML listing");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].relative_path, "XML/SKILL_LIFE.xml");

        fs::create_dir_all(directory.path().join("data/XML")).unwrap();
        fs::write(
            directory.path().join("data/XML/SKILL_LIFE.xml"),
            b"<override />",
        )
        .unwrap();
        let override_read = storage.handle(StorageRequest {
            request_id: 3,
            namespace: StorageNamespace::Data,
            relative_path: "XML/SKILL_LIFE.xml".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        let StorageResult::Read { data, .. } = override_read.result else {
            panic!("expected private text data");
        };
        assert_eq!(data.as_slice(), b"<override />");

        let written = storage.handle(StorageRequest {
            request_id: 4,
            namespace: StorageNamespace::Data,
            relative_path: "XML/SKILL_LIFE.xml".into(),
            operation: StorageOperation::Write {
                data: ProtocolBytes::new(b"<written />".to_vec()),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            },
            idempotency_key: String::new(),
            deadline_ns: None,
        });
        assert!(matches!(written.result, StorageResult::Written { .. }));
        assert_eq!(
            fs::read(directory.path().join("data/XML/SKILL_LIFE.xml")).unwrap(),
            b"<written />"
        );
        assert_eq!(
            fs::read(directory.path().join("XML/SKILL_LIFE.xml")).unwrap(),
            b"<project />"
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_root_fallback_rejects_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("XML")).unwrap();
        fs::write(outside.path().join("secret.xml"), b"secret").unwrap();
        symlink(
            outside.path().join("secret.xml"),
            directory.path().join("XML/SKILL_LIFE.xml"),
        )
        .unwrap();
        let mut storage = StorageHost::new(directory.path().to_owned());

        let response = storage.handle(StorageRequest {
            request_id: 1,
            namespace: StorageNamespace::Data,
            relative_path: "XML/SKILL_LIFE.xml".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        });

        let StorageResult::Error { error } = response.result else {
            panic!("expected a namespace permission error");
        };
        // Escaping an authorized namespace is a permission failure, never a missing-file fallback.
        assert_eq!(error.kind, FrontendIoErrorKind::PermissionDenied);
    }
}
