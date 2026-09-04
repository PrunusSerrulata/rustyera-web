use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FileChange, FilePayload, ProjectIdentity, ProjectManifest, ReloadProject,
    SubmittedFile, validate_relative_path,
};

use super::{
    IndexedFile, PendingProjectReload, ProjectHost, ProjectReloadScope, ProjectReloadSelector,
    ProjectReloadTargets, by_path, canonical_source_roots, decode_packaged_project,
    indexed_by_path, materialize_indexed_file, metadata_signature, parallel_ordered,
    project_entries, relative_path, validate_source_path, write_cbor_bytes, write_cbor_head,
    write_cbor_text, write_counted,
};

impl ProjectHost {
    pub fn invalidate_compiled_cache(&self) {
        let _ = fs::remove_file(self.compiled_cache_path());
    }

    pub fn identity(&self) -> ProjectIdentity {
        let mut hasher = blake3::Hasher::new_derive_key("rustyera.project-source-identity.v1");
        for file in &self.indexed_files {
            let path = file.relative_path.as_bytes();
            hasher.update(&(path.len() as u64).to_le_bytes());
            hasher.update(path);
            hasher.update(&[file.category as u8]);
            hasher.update(&file.content_hash);
        }
        ProjectIdentity {
            project_revision: self.revision,
            source_digest: ProtocolBytes::new(hasher.finalize().as_bytes().to_vec()),
            compatibility: self.compatibility.clone(),
            configuration_digest: self
                .indexed_files
                .iter()
                .find(|file| file.relative_path.eq_ignore_ascii_case("reraconfig.toml"))
                .map(|file| ProtocolBytes::new(file.content_hash.to_vec())),
        }
    }

    #[cfg(test)]
    pub fn materialize(&mut self) -> Result<&ProjectManifest, String> {
        self.materialize_with_progress(None)
    }

    pub fn materialize_with_progress(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<&ProjectManifest, String> {
        self.materialize_with_progress_and_cancel(progress, None)
    }

    pub fn materialize_with_progress_and_cancel(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
        cancelled: Option<&AtomicBool>,
    ) -> Result<&ProjectManifest, String> {
        if self.manifest.is_none() {
            if let Some(progress) = progress {
                progress(0, self.indexed_files.len());
            }
            let root = &self.root;
            let indexed_files = &self.indexed_files;
            let files = parallel_ordered(indexed_files.len(), progress, cancelled, |index| {
                materialize_indexed_file(root, &indexed_files[index])
            })?;
            let manifest = ProjectManifest {
                project_revision: self.revision,
                files,
                compatibility: self.compatibility.clone(),
            };
            if era_web_bridge::project_identity(&manifest)? != self.identity() {
                return Err("project changed while its source files were being loaded".into());
            }
            for indexed in &mut self.indexed_files {
                indexed.pending_file = None;
            }
            self.manifest = Some(manifest);
        }
        self.manifest
            .as_ref()
            .ok_or_else(|| "project manifest was not materialized".to_owned())
    }

    pub fn write_full_manifest_with_progress_and_cancel(
        &mut self,
        output: &mut impl Write,
        progress: Option<&dyn Fn(usize, usize)>,
        cancelled: Option<&AtomicBool>,
    ) -> Result<u64, String> {
        self.materialize_with_progress_and_cancel(progress, cancelled)?;
        let manifest = self
            .manifest
            .take()
            .ok_or_else(|| "project manifest was not materialized".to_owned())?;
        let mut written = 0_u64;
        write_counted(output, &mut written, &[0xa3, 0x00])?;
        write_cbor_head(output, &mut written, 0, manifest.project_revision)?;
        write_counted(output, &mut written, &[0x01])?;
        write_cbor_head(output, &mut written, 4, manifest.files.len() as u64)?;
        let total = manifest.files.len();
        for (index, file) in manifest.files.iter().enumerate() {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err("project export was cancelled".into());
            }
            write_cbor_head(
                output,
                &mut written,
                5,
                3 + u64::from(file.content_hash.is_some()),
            )?;
            write_counted(output, &mut written, &[0x00])?;
            write_cbor_text(output, &mut written, &file.relative_path)?;
            write_counted(output, &mut written, &[0x01])?;
            write_cbor_head(output, &mut written, 0, file.category as u64)?;
            write_counted(output, &mut written, &[0x02, 0x82])?;
            match &file.payload {
                FilePayload::Utf8(text) => {
                    write_counted(output, &mut written, &[0x00, 0x81])?;
                    write_cbor_text(output, &mut written, text)?;
                }
                FilePayload::Bytes(bytes) => {
                    write_counted(output, &mut written, &[0x01, 0x81])?;
                    write_cbor_bytes(output, &mut written, bytes.as_slice())?;
                }
                FilePayload::ExternalResource(resource) => {
                    write_counted(output, &mut written, &[0x01, 0x81])?;
                    write_cbor_head(output, &mut written, 2, resource.byte_length)?;
                    self.write_resource_to(output, &mut written, file, cancelled)?;
                }
                FilePayload::IoError(_) => {
                    return Err(format!(
                        "cannot export unreadable project file: {}",
                        file.relative_path
                    ));
                }
            }
            if let Some(hash) = &file.content_hash {
                write_counted(output, &mut written, &[0x03])?;
                write_cbor_bytes(output, &mut written, hash.as_slice())?;
            }
            if let Some(progress) = progress {
                progress(index + 1, total);
            }
        }
        write_counted(output, &mut written, &[0x02])?;
        let compatibility = era_protocol::encode_canonical(&manifest.compatibility)
            .map_err(|error| error.to_string())?;
        write_counted(output, &mut written, &compatibility)?;
        Ok(written)
    }

    fn write_resource_to(
        &self,
        output: &mut impl Write,
        written: &mut u64,
        file: &SubmittedFile,
        cancelled: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let indexed = self
            .indexed_files
            .iter()
            .find(|indexed| {
                indexed
                    .relative_path
                    .eq_ignore_ascii_case(&file.relative_path)
            })
            .ok_or_else(|| format!("unknown resource: {}", file.relative_path))?;
        let path = self.resource_path(&file.relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("cannot stat resource: {error}"))?;
        if indexed
            .source_signature
            .is_none_or(|expected| metadata_signature(&metadata) != expected)
        {
            return Err(format!(
                "resource changed after project scan: {}",
                file.relative_path
            ));
        }
        let mut input =
            fs::File::open(&path).map_err(|error| format!("cannot open resource: {error}"))?;
        let mut buffer = vec![0_u8; 4 * 1024 * 1024];
        let mut hasher = blake3::Hasher::new();
        let mut resource_bytes = 0_u64;
        loop {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err("project export was cancelled".into());
            }
            let count = input
                .read(&mut buffer)
                .map_err(|error| format!("cannot read resource: {error}"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            write_counted(output, written, &buffer[..count])?;
            resource_bytes += count as u64;
        }
        let expected_length = match &file.payload {
            FilePayload::ExternalResource(resource) => resource.byte_length,
            _ => 0,
        };
        if resource_bytes != expected_length
            || file.content_hash.as_ref().map(ProtocolBytes::as_slice)
                != Some(hasher.finalize().as_bytes().as_slice())
            || fs::metadata(path)
                .map(|current| metadata_signature(&current))
                .map_err(|error| format!("cannot stat resource: {error}"))?
                != metadata_signature(&metadata)
        {
            return Err(format!(
                "resource changed after project scan: {}",
                file.relative_path
            ));
        }
        Ok(())
    }

    pub fn take_manifest_with_progress(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<ProjectManifest, String> {
        if let Some(project) = &self.packaged_project {
            if let Some(manifest) = self.manifest.take() {
                return Ok(manifest);
            }
            return decode_packaged_project(&project.path, progress)
                .map(|decoded| decoded.project.manifest);
        }
        self.materialize_with_progress(progress)?;
        self.manifest
            .take()
            .ok_or_else(|| "project manifest was not materialized".to_owned())
    }

    pub fn compiled_cache(&self) -> Result<Option<Vec<u8>>, String> {
        match fs::read(self.compiled_cache_path()) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("cannot read compiled project cache: {error}")),
        }
    }

    pub fn project_reload_targets(&self) -> Result<ProjectReloadTargets, String> {
        if self.packaged_project.is_some() {
            return Ok(ProjectReloadTargets {
                folders: Vec::new(),
                scripts: Vec::new(),
            });
        }
        let canonical_roots = canonical_source_roots(&self.root)?;
        let mut scripts = self
            .indexed_files
            .iter()
            .filter(|file| {
                matches!(
                    file.category,
                    FileCategory::Erb | FileCategory::Erh | FileCategory::Als | FileCategory::Erd
                )
            })
            .map(|file| file.relative_path.clone())
            .collect::<BTreeSet<_>>();
        for (path, category) in project_entries(&self.root, &canonical_roots)? {
            if matches!(
                category,
                FileCategory::Erb | FileCategory::Erh | FileCategory::Als | FileCategory::Erd
            ) {
                scripts.insert(relative_path(&self.root, &path)?);
            }
        }
        let folders = scripts
            .iter()
            .filter_map(|path| path.rsplit_once('/').map(|(folder, _)| folder.to_owned()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(ProjectReloadTargets {
            folders,
            scripts: scripts.into_iter().collect(),
        })
    }

    pub fn reload_scoped_with_progress(
        &mut self,
        scope: &ProjectReloadScope,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<ReloadProject, String> {
        if self.packaged_project.is_some() {
            return Err("a packaged project cannot reload source files".into());
        }
        if self.pending_reload.is_some() {
            return Err("a project reload is already awaiting runtime confirmation".into());
        }
        let selector = ProjectReloadSelector::new(scope)?;
        let candidate =
            Self::scan_with_progress(&self.root, self.revision.saturating_add(1), progress)?;
        if self.runtime_manifest_sparse {
            // A cache-backed runtime owns identities but not source payloads. Send one complete
            // current source set (plus removals) so the runtime becomes a full delta baseline;
            // keeping that baseline in ProjectHost would reintroduce a second long-lived owner.
            return self.hydrate_sparse_reload(&selector, candidate);
        }
        let new_manifest = candidate
            .manifest
            .as_ref()
            .ok_or_else(|| "candidate manifest was not materialized".to_owned())?;
        let old = indexed_by_path(&self.indexed_files);
        let new = indexed_by_path(&candidate.indexed_files);
        let new_files = by_path(new_manifest);
        let paths = old
            .keys()
            .chain(new.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let changes = paths
            .into_iter()
            .filter(|path| {
                new.get(path)
                    .or_else(|| old.get(path))
                    .is_some_and(|file| selector.matches(path, file.category))
            })
            .filter_map(|path| match (old.get(path), new.get(path)) {
                (Some(previous), Some(current))
                    if previous.category == current.category
                        && previous.content_hash == current.content_hash =>
                {
                    None
                }
                (_, Some(_)) => Some(FileChange::Upsert {
                    file: (*new_files
                        .get(path)
                        .expect("candidate index must match its manifest"))
                    .clone(),
                }),
                (Some(previous), None) => Some(FileChange::Remove {
                    category: previous.category,
                    relative_path: path.to_owned(),
                }),
                (None, None) => None,
            })
            .collect();
        let request = ReloadProject {
            base_revision: self.revision,
            target_revision: candidate.revision,
            changes,
        };
        let indexed_files = if matches!(&selector, ProjectReloadSelector::All) {
            candidate.indexed_files.clone()
        } else {
            self.merged_scoped_index(&selector, &candidate)
        };
        self.pending_reload = Some(PendingProjectReload {
            indexed_files,
            revision: candidate.revision,
            runtime_manifest_sparse: false,
        });
        self.manifest = None;
        Ok(request)
    }

    fn hydrate_sparse_reload(
        &mut self,
        selector: &ProjectReloadSelector,
        candidate: Self,
    ) -> Result<ReloadProject, String> {
        let manifest = candidate
            .manifest
            .as_ref()
            .ok_or_else(|| "candidate manifest was not materialized".to_owned())?;
        let old = indexed_by_path(&self.indexed_files);
        let new = indexed_by_path(&candidate.indexed_files);
        let unselected_changed = old
            .keys()
            .chain(new.keys())
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .any(|path| {
                let indexed = new.get(path).or_else(|| old.get(path));
                if indexed.is_some_and(|file| selector.matches(path, file.category)) {
                    return false;
                }
                match (old.get(path), new.get(path)) {
                    (Some(previous), Some(current)) => {
                        previous.category != current.category
                            || previous.content_hash != current.content_hash
                    }
                    (None, None) => false,
                    _ => true,
                }
            });
        if unselected_changed {
            return Err("缓存项目无法在保留其他磁盘改动的同时执行局部重载，请改用全部重载".into());
        }
        let hydrated_paths = manifest
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<BTreeSet<_>>();
        let mut changes = manifest
            .files
            .iter()
            .cloned()
            .map(|file| FileChange::Upsert { file })
            .collect::<Vec<_>>();
        changes.extend(
            self.indexed_files
                .iter()
                .filter(|file| !hydrated_paths.contains(file.relative_path.as_str()))
                .map(|file| FileChange::Remove {
                    category: file.category,
                    relative_path: file.relative_path.clone(),
                }),
        );
        let request = ReloadProject {
            base_revision: self.revision,
            target_revision: candidate.revision,
            changes,
        };
        self.pending_reload = Some(PendingProjectReload {
            indexed_files: self.merged_scoped_index(selector, &candidate),
            revision: candidate.revision,
            runtime_manifest_sparse: false,
        });
        self.manifest = None;
        Ok(request)
    }

    fn merged_scoped_index(
        &self,
        selector: &ProjectReloadSelector,
        candidate: &Self,
    ) -> Vec<IndexedFile> {
        let mut files = self
            .indexed_files
            .iter()
            .filter(|file| !selector.matches(&file.relative_path, file.category))
            .cloned()
            .chain(
                candidate
                    .indexed_files
                    .iter()
                    .filter(|file| selector.matches(&file.relative_path, file.category))
                    .cloned(),
            )
            .collect::<Vec<_>>();
        files.sort_by(|left, right| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        files
    }

    pub fn finalize_reload(&mut self, success: bool) {
        let Some(pending) = self.pending_reload.take() else {
            return;
        };
        if !success {
            self.manifest = None;
            return;
        }
        self.indexed_files = pending.indexed_files;
        self.revision = pending.revision;
        self.manifest = None;
        self.runtime_manifest_sparse = pending.runtime_manifest_sparse;
    }

    pub fn read_resource(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        if self.packaged_project.is_some() {
            return self.read_packaged_resource(relative_path, None);
        }
        if let Some(bytes) = self.embedded_resources.get(&relative_path.to_lowercase()) {
            return Ok(bytes.clone());
        }
        let path = self.resource_path(relative_path)?;
        let indexed = self
            .indexed_files
            .iter()
            .find(|file| file.relative_path.eq_ignore_ascii_case(relative_path))
            .ok_or_else(|| format!("unknown resource: {relative_path}"))?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("cannot stat resource: {error}"))?;
        if indexed
            .source_signature
            .is_some_and(|signature| metadata_signature(&metadata) != signature)
        {
            return Err(format!(
                "resource changed after project scan: {relative_path}"
            ));
        }
        let bytes = fs::read(path).map_err(|error| format!("cannot read resource: {error}"))?;
        if blake3::hash(&bytes).as_bytes() != &indexed.content_hash {
            return Err(format!(
                "resource changed after project scan: {relative_path}"
            ));
        }
        Ok(bytes)
    }

    pub fn read_resource_prefix(
        &self,
        relative_path: &str,
        maximum_bytes: u32,
    ) -> Result<Vec<u8>, String> {
        if self.packaged_project.is_some() {
            return self.read_packaged_resource(relative_path, Some(maximum_bytes as usize));
        }
        if let Some(bytes) = self.embedded_resources.get(&relative_path.to_lowercase()) {
            return Ok(bytes[..bytes.len().min(maximum_bytes as usize)].to_vec());
        }
        let indexed = self
            .indexed_files
            .iter()
            .find(|file| file.relative_path.eq_ignore_ascii_case(relative_path))
            .ok_or_else(|| format!("unknown resource: {relative_path}"))?;
        let path = self.resource_path(relative_path)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("cannot stat resource: {error}"))?;
        if indexed
            .source_signature
            .is_none_or(|signature| metadata_signature(&metadata) != signature)
        {
            return Err(format!(
                "resource changed after project scan: {relative_path}"
            ));
        }
        let mut bytes = Vec::with_capacity(maximum_bytes as usize);
        fs::File::open(&path)
            .map_err(|error| format!("cannot open resource: {error}"))?
            .take(u64::from(maximum_bytes))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read resource header: {error}"))?;
        if fs::metadata(path)
            .map(|current| metadata_signature(&current))
            .map_err(|error| format!("cannot stat resource: {error}"))?
            != metadata_signature(&metadata)
        {
            return Err(format!(
                "resource changed after project scan: {relative_path}"
            ));
        }
        Ok(bytes)
    }

    pub(super) fn read_packaged_resource(
        &self,
        relative_path: &str,
        maximum_bytes: Option<usize>,
    ) -> Result<Vec<u8>, String> {
        validate_relative_path(relative_path).map_err(|error| error.to_string())?;
        let project = self
            .packaged_project
            .as_ref()
            .ok_or_else(|| "project is not a packaged project".to_owned())?;
        let decoded = decode_packaged_project(&project.path, None)?;
        if decoded.file_digest != project.file_digest {
            return Err("project file changed after it was opened".into());
        }
        let file = decoded
            .project
            .manifest
            .files
            .into_iter()
            .find(|file| {
                file.category == FileCategory::Resource
                    && file.relative_path.eq_ignore_ascii_case(relative_path)
            })
            .ok_or_else(|| format!("unknown resource: {relative_path}"))?;
        let bytes = match file.payload {
            FilePayload::Bytes(bytes) => bytes.into_inner(),
            _ => {
                return Err(format!(
                    "packaged resource has no embedded bytes: {relative_path}"
                ));
            }
        };
        Ok(match maximum_bytes {
            Some(maximum) if bytes.len() > maximum => bytes[..maximum].to_vec(),
            _ => bytes,
        })
    }

    fn resource_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        let relative = validate_relative_path(relative_path).map_err(|error| error.to_string())?;
        let path = self.root.join(relative);
        validate_source_path(&self.root, &path, FileCategory::Resource)?;
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("cannot open resource: {error}"))?;
        if canonical != self.root && !canonical.starts_with(&self.root) {
            return Err("resource path escapes the project root".into());
        }
        Ok(canonical)
    }
}
