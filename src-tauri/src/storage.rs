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

mod path;

use path::{
    change_token, conflict, ensure_inside, frontend_error, invalid_path, resolve, revision,
    validate_read_path,
};

pub struct StorageHost {
    project_root: PathBuf,
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
const MAXIMUM_RELATIVE_PATH_BYTES: usize = 4 * 1024;
const MAXIMUM_FULL_READ_BYTES: usize = 64 * 1024 * 1024;
const MAXIMUM_RANGE_READ_BYTES: u32 = 4 * 1024 * 1024;
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
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            project_root,
            idempotent: BTreeMap::new(),
            idempotent_order: VecDeque::new(),
            idempotent_bytes: 0,
        }
    }

    pub fn handle(&mut self, request: StorageRequest) -> StorageResponse {
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
        let (root, path) = if matches!(
            &operation,
            StorageOperation::Read
                | StorageOperation::List { .. }
                | StorageOperation::Stat
                | StorageOperation::ReadRange { .. }
        ) {
            self.resolve_for_read(namespace, relative_path)?
        } else {
            let root = self.namespace_root(namespace);
            let path = resolve(&root, relative_path)?;
            (root, path)
        };
        match operation {
            StorageOperation::Read => {
                let (data, revision) = read_bounded_with_revision(&path)?;
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
                verify_precondition_bounded(&path, &precondition)?;
                let parent = path.parent().ok_or_else(invalid_path)?;
                fs::create_dir_all(parent)?;
                ensure_inside(&root, parent)?;
                if atomic_replace {
                    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                    temporary.write_all(data.as_slice())?;
                    temporary.as_file().sync_all()?;
                    temporary.persist(&path).map_err(|error| error.error)?;
                } else {
                    fs::write(&path, data.as_slice())?;
                }
                Ok(StorageResult::Written {
                    revision: Some(revision(data.as_slice())),
                })
            }
            StorageOperation::List { pattern, recursive } => {
                if pattern
                    .as_ref()
                    .is_some_and(|value| value.len() > MAXIMUM_RELATIVE_PATH_BYTES)
                {
                    return Err(budget_exceeded("storage list pattern"));
                }
                let pattern = pattern
                    .as_deref()
                    .map(glob::Pattern::new)
                    .transpose()
                    .map_err(|error| {
                        std::io::Error::new(std::io::ErrorKind::InvalidInput, error)
                    })?;
                let mut entries = Vec::new();
                let mut retained_path_bytes = 0_usize;
                if path.exists() {
                    let walker = walkdir::WalkDir::new(&path)
                        .min_depth(1)
                        .max_depth(if recursive { usize::MAX } else { 1 });
                    for entry in walker {
                        let entry = entry.map_err(std::io::Error::other)?;
                        if !entry.file_type().is_file() {
                            continue;
                        }
                        let relative = entry
                            .path()
                            .strip_prefix(&root)
                            .map_err(|_| invalid_path())?
                            .to_string_lossy()
                            .replace('\\', "/");
                        if relative.len() > MAXIMUM_RELATIVE_PATH_BYTES {
                            return Err(budget_exceeded("listed storage path"));
                        }
                        if pattern
                            .as_ref()
                            .is_some_and(|value| !value.matches_path(Path::new(entry.file_name())))
                        {
                            continue;
                        }
                        account_list_entry(
                            entries.len(),
                            &mut retained_path_bytes,
                            relative.len(),
                        )?;
                        let metadata = entry.metadata().map_err(std::io::Error::other)?;
                        entries.push(StorageEntry {
                            relative_path: relative,
                            byte_length: metadata.len(),
                            revision: None,
                            change_token: Some(change_token(&metadata)),
                        });
                    }
                }
                entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                Ok(StorageResult::Listed { entries })
            }
            StorageOperation::Delete { precondition } => {
                verify_precondition_bounded(&path, &precondition)?;
                fs::remove_file(path)?;
                Ok(StorageResult::Deleted)
            }
            StorageOperation::Stat => {
                let (byte_length, revision) = stream_revision(&path)?;
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
                let before = fs::metadata(&path)?;
                let token = change_token(&before);
                if expected.as_ref().is_some_and(|value| value != &token) {
                    return Err(conflict("storage file changed before range read"));
                }
                let mut file = File::open(&path)?;
                file.seek(SeekFrom::Start(offset))?;
                let mut data = vec![0; maximum_bytes as usize];
                let length = file.read(&mut data)?;
                data.truncate(length);
                let after = fs::metadata(&path)?;
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
            StorageNamespace::Project => self.project_root.join("project"),
            // Emuera stores normal slots and global.sav in the project's sav directory.
            StorageNamespace::Save | StorageNamespace::GlobalSave => self.project_root.join("sav"),
            StorageNamespace::Data => self.project_root.join("data"),
            StorageNamespace::Log => self.project_root.join("logs"),
            StorageNamespace::Resource => self.project_root.clone(),
        }
    }

    fn resolve_for_read(
        &self,
        namespace: StorageNamespace,
        relative_path: &str,
    ) -> Result<(PathBuf, PathBuf), std::io::Error> {
        let root = self.namespace_root(namespace);
        let primary = resolve(&root, relative_path)?;
        if matches!(
            namespace,
            StorageNamespace::Project | StorageNamespace::Data
        ) && !primary.try_exists()?
        {
            let path = resolve(&self.project_root, relative_path)?;
            return validate_read_path(&self.project_root, path);
        }
        validate_read_path(&root, primary)
    }
}

fn budget_exceeded(subject: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("{subject} exceeds the native host memory budget"),
    )
}

fn account_list_entry(
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
            panic!("expected an invalid path error");
        };
        assert_eq!(error.kind, FrontendIoErrorKind::InvalidData);
    }
}
