use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FrontendIoError, FrontendIoErrorKind, StorageEntry, StorageMetadata, StorageNamespace,
    StorageOperation, StoragePrecondition, StorageRequest, StorageResponse, StorageResult,
    validate_relative_path,
};

pub struct StorageHost {
    project_root: PathBuf,
    idempotent: BTreeMap<String, StorageResult>,
}

impl StorageHost {
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            project_root,
            idempotent: BTreeMap::new(),
        }
    }

    pub fn handle(&mut self, request: StorageRequest) -> StorageResponse {
        if !request.idempotency_key.is_empty()
            && let Some(result) = self.idempotent.get(&request.idempotency_key)
        {
            return StorageResponse {
                request_id: request.request_id,
                result: result.clone(),
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
            self.idempotent
                .insert(request.idempotency_key, result.clone());
        }
        StorageResponse {
            request_id: request.request_id,
            result,
        }
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
        let root = self.namespace_root(namespace);
        let path = resolve(&root, relative_path)?;
        match operation {
            StorageOperation::Read => {
                let data = fs::read(path)?;
                let revision = revision(&data);
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
                verify_precondition(&path, &precondition)?;
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
                let pattern = pattern
                    .as_deref()
                    .map(glob::Pattern::new)
                    .transpose()
                    .map_err(|error| {
                        std::io::Error::new(std::io::ErrorKind::InvalidInput, error)
                    })?;
                let mut entries = Vec::new();
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
                        if pattern
                            .as_ref()
                            .is_some_and(|value| !value.matches_path(entry.path()))
                        {
                            continue;
                        }
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
                verify_precondition(&path, &precondition)?;
                fs::remove_file(path)?;
                Ok(StorageResult::Deleted)
            }
            StorageOperation::Stat => {
                let data = fs::read(path)?;
                Ok(StorageResult::Metadata(StorageMetadata {
                    byte_length: u64::try_from(data.len()).unwrap_or(u64::MAX),
                    revision: Some(revision(&data)),
                }))
            }
            StorageOperation::ReadRange {
                offset,
                maximum_bytes,
                change_token: expected,
            } => {
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
            StorageNamespace::Save => self.project_root.join("save"),
            StorageNamespace::GlobalSave => self.project_root.join("global"),
            StorageNamespace::Data => self.project_root.join("data"),
            StorageNamespace::Log => self.project_root.join("logs"),
            StorageNamespace::Resource => self.project_root.clone(),
        }
    }
}

fn resolve(root: &Path, relative_path: &str) -> Result<PathBuf, std::io::Error> {
    if relative_path.is_empty() {
        return Ok(root.to_owned());
    }
    let relative = validate_relative_path(relative_path)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    Ok(root.join(relative))
}

fn ensure_inside(root: &Path, parent: &Path) -> Result<(), std::io::Error> {
    let project = root.canonicalize().or_else(|_| {
        fs::create_dir_all(root)?;
        root.canonicalize()
    })?;
    let parent = parent.canonicalize()?;
    if parent == project || parent.starts_with(project) {
        Ok(())
    } else {
        Err(invalid_path())
    }
}

fn verify_precondition(
    path: &Path,
    precondition: &StoragePrecondition,
) -> Result<(), std::io::Error> {
    let current = match fs::read(path) {
        Ok(bytes) => Some(revision(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let matches = match precondition {
        StoragePrecondition::Any => true,
        StoragePrecondition::Missing => current.is_none(),
        StoragePrecondition::Revision(expected) => current.as_ref() == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(conflict("storage precondition did not hold"))
    }
}

fn revision(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

fn change_token(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    format!("{}:{modified}", metadata.len())
}

fn conflict(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::AlreadyExists, message)
}

fn invalid_path() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "storage path escapes its namespace",
    )
}

fn frontend_error(error: &std::io::Error) -> FrontendIoError {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => FrontendIoErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied => FrontendIoErrorKind::PermissionDenied,
        std::io::ErrorKind::InvalidData | std::io::ErrorKind::InvalidInput => {
            FrontendIoErrorKind::InvalidData
        }
        std::io::ErrorKind::Interrupted => FrontendIoErrorKind::Interrupted,
        std::io::ErrorKind::AlreadyExists => FrontendIoErrorKind::Conflict,
        _ => FrontendIoErrorKind::Other,
    };
    FrontendIoError {
        kind,
        message: error.to_string(),
        platform_code: error.raw_os_error().map(i64::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_is_rejected() {
        let root = Path::new("project");
        assert!(resolve(root, "../secret").is_err());
        assert!(resolve(root, "/secret").is_err());
    }
}
