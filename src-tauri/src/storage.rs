use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    StorageEntry, StorageMetadata, StorageNamespace, StorageOperation, StorageRequest,
    StorageResponse, StorageResult,
};

mod path;

use path::{
    change_token, conflict, ensure_inside, frontend_error, invalid_path, resolve, revision,
    validate_read_path, verify_precondition,
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
                            .is_some_and(|value| !value.matches_path(Path::new(entry.file_name())))
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
