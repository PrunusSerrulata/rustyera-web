use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use unicode_normalization::UnicodeNormalization;

use era_runtime_protocol::storage_pattern::{
    matches_snake_storage_pattern, validate_snake_storage_pattern,
};
use era_runtime_protocol::{
    CompatibilityProfileId, FileCategory, FilePayload, ProtocolBytes, StorageEntry,
    StorageMetadata, StorageOperation, StorageResult,
};

use super::{
    IndexedFile, ProjectHost, metadata_signature, validate_relative_path, validate_source_path,
};
use crate::storage::{
    MAXIMUM_FULL_READ_BYTES, MAXIMUM_RANGE_READ_BYTES, MAXIMUM_RELATIVE_PATH_BYTES,
    account_list_entry, budget_exceeded,
};

const MAXIMUM_RESOURCE_CONTAINER_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_RESOURCE_CONTAINER_DECODED_BYTES: u64 = 128 * 1024 * 1024;

impl ProjectHost {
    pub(crate) fn resource_storage(
        &self,
        relative: &str,
        operation: StorageOperation,
        profile: CompatibilityProfileId,
    ) -> io::Result<StorageResult> {
        let relative = normalized_path(relative)?;
        // Only the active index authorizes reads. A pending reload has a separate index.
        let mut resources = BTreeMap::new();
        let mut manifest_path_bytes = 0;
        for item in &self.indexed_files {
            if item.category != FileCategory::Resource {
                continue;
            }
            let path = normalized_path(&item.relative_path)?;
            account_list_entry(resources.len(), &mut manifest_path_bytes, path.len())?;
            if resources
                .insert(path.to_lowercase(), (path, item))
                .is_some()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "resource manifest contains duplicate normalized paths",
                ));
            }
        }
        if let StorageOperation::List { pattern, recursive } = operation {
            return self.list_storage_resources(
                resources,
                &relative,
                pattern.as_deref(),
                recursive,
                profile,
            );
        }
        let (_, item) = resources.get(&relative.to_lowercase()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "resource is not authorized by the active project manifest",
            )
        })?;
        match operation {
            StorageOperation::Read => {
                if item.byte_length > MAXIMUM_FULL_READ_BYTES as u64 {
                    return Err(budget_exceeded("resource full read"));
                }
                let observed =
                    self.verified_storage_resource(item, 0, MAXIMUM_FULL_READ_BYTES, None)?;
                Ok(StorageResult::Read {
                    data: ProtocolBytes::new(observed.data),
                    revision: Some(observed.revision),
                })
            }
            StorageOperation::Stat => {
                let observed = self.verified_storage_resource(item, 0, 0, None)?;
                Ok(StorageResult::Metadata(StorageMetadata {
                    byte_length: item.byte_length,
                    revision: Some(observed.revision),
                }))
            }
            StorageOperation::ReadRange {
                offset,
                maximum_bytes,
                change_token,
            } => {
                if maximum_bytes == 0 || maximum_bytes > MAXIMUM_RANGE_READ_BYTES {
                    return Err(budget_exceeded("resource range read"));
                }
                let observed = self.verified_storage_resource(
                    item,
                    offset,
                    maximum_bytes as usize,
                    change_token.as_deref(),
                )?;
                let complete =
                    offset.saturating_add(observed.data.len() as u64) >= item.byte_length;
                Ok(StorageResult::ReadChunk {
                    data: ProtocolBytes::new(observed.data),
                    offset,
                    complete,
                    change_token: observed.token,
                })
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid resource storage operation",
            )),
        }
    }

    fn list_storage_resources(
        &self,
        resources: BTreeMap<String, (String, &IndexedFile)>,
        relative: &str,
        pattern: Option<&str>,
        recursive: bool,
        profile: CompatibilityProfileId,
    ) -> io::Result<StorageResult> {
        if pattern.is_some_and(|pattern| pattern.len() > MAXIMUM_RELATIVE_PATH_BYTES) {
            return Err(budget_exceeded("resource list pattern"));
        }
        let snake = profile == CompatibilityProfileId::EmueraSkiaSnake;
        if snake {
            validate_snake_storage_pattern(pattern)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        }
        let original_pattern = if snake {
            None
        } else {
            pattern
                .map(glob::Pattern::new)
                .transpose()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?
        };
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{}/", relative.to_lowercase())
        };
        let mut entries = Vec::new();
        let mut path_bytes = 0;
        for (key, (path, item)) in resources {
            let Some(tail) = key.strip_prefix(&prefix) else {
                continue;
            };
            if tail.is_empty() || (!recursive && tail.contains('/')) {
                continue;
            }
            let name = path.rsplit('/').next().unwrap_or_default();
            let selected = if snake {
                matches_snake_storage_pattern(pattern, name)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
            } else {
                original_pattern
                    .as_ref()
                    .is_none_or(|pattern| pattern.matches_path(Path::new(name)))
            };
            if !selected {
                continue;
            }
            account_list_entry(entries.len(), &mut path_bytes, path.len())?;
            let observed = self.verified_storage_resource(item, 0, 0, None)?;
            entries.push(StorageEntry {
                relative_path: path,
                byte_length: item.byte_length,
                revision: Some(observed.revision),
                change_token: Some(observed.token),
            });
        }
        entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(StorageResult::Listed { entries })
    }

    fn verified_storage_resource(
        &self,
        item: &IndexedFile,
        offset: u64,
        maximum: usize,
        expected: Option<&str>,
    ) -> io::Result<VerifiedResource> {
        if self.packaged_project.is_some() {
            if item.byte_length > MAXIMUM_FULL_READ_BYTES as u64 {
                return Err(budget_exceeded("packaged resource"));
            }
            let bytes = self.bounded_packaged_storage_resource(&item.relative_path)?;
            let token = format!("resource:{}", blake3::Hash::from_bytes(item.content_hash));
            return verify_stream(bytes.as_slice(), item, offset, maximum, token, expected);
        }
        if let Some(bytes) = self
            .embedded_resources
            .get(&item.relative_path.to_lowercase())
        {
            let token = format!("resource:{}", blake3::Hash::from_bytes(item.content_hash));
            return verify_stream(bytes.as_slice(), item, offset, maximum, token, expected);
        }
        let relative = validate_relative_path(&item.relative_path)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let source = item
            .source_path
            .clone()
            .unwrap_or_else(|| self.root.join(relative));
        validate_source_path(&self.root, &source, FileCategory::Resource)
            .map_err(|message| io::Error::new(io::ErrorKind::PermissionDenied, message))?;
        let canonical = source
            .canonicalize()
            .map_err(crate::storage::path::traversal_error)?;
        if canonical == self.root || !canonical.starts_with(&self.root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "resource path escaped the authorized root",
            ));
        }
        let mut file = fs::File::open(&source).map_err(crate::storage::path::traversal_error)?;
        let before = file.metadata()?;
        let signature = metadata_signature(&before);
        if before.len() != item.byte_length
            || item
                .source_signature
                .is_some_and(|expected| signature != expected)
        {
            return Err(changed());
        }
        let token = crate::storage::path::change_token(&before);
        let observed = verify_stream(&mut file, item, offset, maximum, token, expected)?;
        if metadata_signature(&file.metadata()?) != signature
            || metadata_signature(
                &fs::metadata(&source).map_err(crate::storage::path::traversal_error)?,
            ) != signature
            || source
                .canonicalize()
                .map_err(crate::storage::path::traversal_error)?
                != canonical
        {
            return Err(changed());
        }
        Ok(observed)
    }

    fn bounded_packaged_storage_resource(&self, relative: &str) -> io::Result<Vec<u8>> {
        let project = self.packaged_project.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "project is not packaged")
        })?;
        let mut file = fs::File::open(&project.path)?;
        let length = usize::try_from(file.metadata()?.len())
            .map_err(|_| budget_exceeded("resource container"))?;
        if length > MAXIMUM_RESOURCE_CONTAINER_BYTES {
            return Err(budget_exceeded("resource container"));
        }
        // The public decoder enforces the decoded-section budget before reserving/decompressing
        // any manifest data. Resource queries never parse the opaque container format here.
        let mut decoder = era_runtime::ProjectFileStreamDecoder::new_with_decoded_limit(
            length,
            MAXIMUM_RESOURCE_CONTAINER_BYTES,
            MAXIMUM_RESOURCE_CONTAINER_DECODED_BYTES,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        loop {
            let length = file.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            decoder
                .append(&buffer[..length])
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        }
        let project_file = decoder
            .finish()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if project_file.file_digest != project.file_digest {
            return Err(changed());
        }
        let resource = project_file
            .project
            .manifest
            .files
            .into_iter()
            .find(|file| {
                file.category == FileCategory::Resource
                    && file.relative_path.eq_ignore_ascii_case(relative)
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "resource is not in the packaged manifest",
                )
            })?;
        match resource.payload {
            FilePayload::Bytes(bytes) => Ok(bytes.into_inner()),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "packaged resource has no binary payload",
            )),
        }
    }
}

struct VerifiedResource {
    data: Vec<u8>,
    revision: String,
    token: String,
}

fn verify_stream(
    mut stream: impl Read,
    item: &IndexedFile,
    offset: u64,
    maximum: usize,
    token: String,
    expected: Option<&str>,
) -> io::Result<VerifiedResource> {
    if expected.is_some_and(|expected| expected != token) {
        return Err(changed());
    }
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut position = 0_u64;
    let mut data = Vec::new();
    loop {
        let length = stream.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        let end = position.saturating_add(length as u64);
        if end > item.byte_length {
            return Err(changed());
        }
        hasher.update(&buffer[..length]);
        let start = position.max(offset);
        let selected_end = end.min(offset.saturating_add(maximum as u64));
        if start < selected_end {
            let local_start = usize::try_from(start - position)
                .map_err(|_| budget_exceeded("resource chunk offset"))?;
            let local_end = usize::try_from(selected_end - position)
                .map_err(|_| budget_exceeded("resource chunk offset"))?;
            data.extend_from_slice(&buffer[local_start..local_end]);
        }
        position = end;
    }
    let digest = hasher.finalize();
    if position != item.byte_length || digest.as_bytes() != &item.content_hash {
        return Err(changed());
    }
    Ok(VerifiedResource {
        data,
        revision: digest.to_hex().to_string(),
        token,
    })
}

fn normalized_path(relative: &str) -> io::Result<String> {
    if relative.len() > MAXIMUM_RELATIVE_PATH_BYTES {
        return Err(budget_exceeded("resource path"));
    }
    if relative.is_empty() {
        return Ok(String::new());
    }
    let path = validate_relative_path(relative)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    Ok(path.replace('\\', "/").nfc().collect())
}

fn changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "resource changed after project scan",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::PackagedProjectFile;

    #[test]
    fn embedded_resources_never_fall_back_to_external_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("seed.xml"), b"embedded").unwrap();
        let mut project = ProjectHost::scan_with_progress(directory.path(), 1, None).unwrap();
        project
            .embedded_resources
            .insert("seed.xml".into(), b"embedded".to_vec());
        fs::write(directory.path().join("seed.xml"), b"outside").unwrap();
        let result = project
            .resource_storage(
                "seed.xml",
                StorageOperation::Read,
                CompatibilityProfileId::EmueraEm,
            )
            .unwrap();
        assert!(
            matches!(result, StorageResult::Read { data, .. } if data.as_slice() == b"embedded")
        );
        project
            .embedded_resources
            .insert("seed.xml".into(), b"corrupt".to_vec());
        assert_eq!(
            project
                .resource_storage(
                    "seed.xml",
                    StorageOperation::Stat,
                    CompatibilityProfileId::EmueraEm
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
    }

    #[test]
    fn resource_storage_rejects_duplicate_normalized_paths_and_oversize_full_reads() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("seed.xml"), b"seed").unwrap();
        let mut project = ProjectHost::scan_with_progress(directory.path(), 1, None).unwrap();
        let mut duplicate = project.indexed_files[0].clone();
        duplicate.relative_path = "SEED.XML".into();
        project.indexed_files.push(duplicate);
        assert_eq!(
            project
                .resource_storage(
                    "",
                    StorageOperation::List {
                        pattern: None,
                        recursive: true
                    },
                    CompatibilityProfileId::EmueraEm
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        project.indexed_files.pop();
        project.indexed_files[0].byte_length = MAXIMUM_FULL_READ_BYTES as u64 + 1;
        fs::remove_file(directory.path().join("seed.xml")).unwrap();
        assert_eq!(
            project
                .resource_storage(
                    "seed.xml",
                    StorageOperation::Read,
                    CompatibilityProfileId::EmueraEm
                )
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn resource_storage_bounds_the_container_before_decoding_any_resource() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("seed.xml"), b"seed").unwrap();
        let mut project = ProjectHost::scan_with_progress(directory.path(), 1, None).unwrap();
        let package_path = directory.path().join("large.reraproj");
        fs::File::create(&package_path)
            .unwrap()
            .set_len(MAXIMUM_RESOURCE_CONTAINER_BYTES as u64 + 1)
            .unwrap();
        project.packaged_project = Some(PackagedProjectFile {
            path: package_path,
            storage_key: "test".into(),
            file_digest: [0; 32],
        });
        let error = project
            .resource_storage(
                "seed.xml",
                StorageOperation::Stat,
                CompatibilityProfileId::EmueraEm,
            )
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("resource container"));
    }
}
