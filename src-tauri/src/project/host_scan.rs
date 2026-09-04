use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    CompatibilityIdentity, CompatibilityProfileId, FileCategory, FilePayload, ProjectManifest,
    SubmittedFile,
};

use super::{
    COMPILED_CACHE_NAME, IndexedFile, MAXIMUM_PROJECT_FONT_BYTES,
    PROJECT_CONFIGURATION_UPDATE_HEADROOM, PackagedProjectFile, ProjectFontSource, ProjectHost,
    SOURCE_INDEX_VERSION, SourceIndex, SourceIndexEntry, canonical_source_roots,
    decode_packaged_project, indexed_file, is_project_font_path, metadata_signature,
    native_configuration_contents, normalize_configuration_text, normalized_file_bytes,
    packaged_project_storage_key, parallel_ordered, project_entries, retry_stable_scan,
    scan_indexed_entry, stable_read_file, write_source_index,
};

fn canonical_project_root(root: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot open project directory: {error}"))?;
    if !root.is_dir() {
        return Err("selected project path is not a directory".into());
    }
    Ok(root)
}

impl ProjectHost {
    pub fn scan_with_progress(
        root: &Path,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<Self, String> {
        if let Some(progress) = progress {
            progress(0, 0);
        }
        let root = canonical_project_root(root)?;
        let canonical_roots = fs::read_dir(&root)
            .map_err(|error| format!("cannot enumerate project directory: {error}"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
            .filter(|name| name == "csv" || name == "erb")
            .collect::<BTreeSet<_>>();
        let entries = project_entries(&root, &canonical_roots)?;
        if let Some(progress) = progress {
            progress(0, entries.len());
        }
        let mut files = parallel_ordered(entries.len(), progress, None, |index| {
            let (path, category) = &entries[index];
            stable_read_file(&root, path, *category).map(|(file, _)| file)
        })?;
        let file_count = files.len();
        files.sort_by(|left, right| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        Ok(Self {
            root,
            compatibility: CompatibilityIdentity::default(),
            indexed_files: files
                .iter()
                .map(indexed_file)
                .collect::<Result<Vec<_>, _>>()?,
            manifest: Some(ProjectManifest {
                project_revision: revision,
                files,
                compatibility: CompatibilityIdentity::default(),
            }),
            revision,
            embedded_resources: BTreeMap::new(),
            packaged_project: None,
            runtime_manifest_sparse: false,
            pending_reload: None,
            source_index_stats: (0, file_count),
        })
    }

    #[cfg(test)]
    pub fn scan_quick(root: &Path, revision: u64) -> Result<Self, String> {
        Self::scan_quick_with_progress(root, revision, None)
    }

    #[cfg(test)]
    pub fn scan_quick_with_progress(
        root: &Path,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<Self, String> {
        Self::scan_quick_with_progress_and_trust(root, revision, progress, true)
    }

    pub fn scan_quick_with_progress_and_trust(
        root: &Path,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
        trust_source_index: bool,
    ) -> Result<Self, String> {
        if let Some(progress) = progress {
            progress(0, 0);
        }
        let root = canonical_project_root(root)?;
        retry_stable_scan(|| {
            Self::scan_quick_once(root.clone(), revision, progress, trust_source_index)
        })
    }

    fn scan_quick_once(
        root: PathBuf,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
        trust_source_index: bool,
    ) -> Result<Self, String> {
        type IndexedScanResult = (IndexedFile, SourceIndexEntry);

        let index_path = root.join(".rustyera/cache/source-index-v1.json");
        let stored_index = fs::read(&index_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SourceIndex>(&bytes).ok())
            .filter(|index| matches!(index.version, 1 | 2 | SOURCE_INDEX_VERSION));
        let portable_index = stored_index
            .as_ref()
            .is_some_and(|index| index.version == SOURCE_INDEX_VERSION);
        let previous = trust_source_index
            .then_some(stored_index.as_ref())
            .flatten()
            .as_ref()
            .map(|index| &index.files)
            .cloned()
            .unwrap_or_default();
        let canonical_roots = canonical_source_roots(&root)?;
        let entries = project_entries(&root, &canonical_roots)?;
        if let Some(progress) = progress {
            progress(0, entries.len());
        }
        let indexed: Vec<IndexedScanResult> =
            parallel_ordered(entries.len(), progress, None, |index| {
                let (path, category) = &entries[index];
                scan_indexed_entry(&root, path, *category, &previous)
            })?;
        let (mut indexed_files, next_index): (Vec<_>, BTreeMap<_, _>) = indexed
            .into_iter()
            .map(|(file, index_entry)| {
                let relative_path = file.relative_path.clone();
                (file, (relative_path, index_entry))
            })
            .unzip();
        indexed_files.sort_by(|left, right| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let current_entries = project_entries(&root, &canonical_roots)?;
        if current_entries != entries
            || indexed_files.iter().any(|indexed| {
                let Some(path) = &indexed.source_path else {
                    return true;
                };
                indexed.source_signature.is_none_or(|signature| {
                    fs::metadata(path)
                        .map_or(true, |metadata| metadata_signature(&metadata) != signature)
                })
            })
        {
            return Err("project changed while it was being scanned".into());
        }
        if !portable_index || previous != next_index {
            write_source_index(
                &index_path,
                &SourceIndex {
                    version: SOURCE_INDEX_VERSION,
                    files: next_index,
                },
            )?;
        }
        let source_index_stats = (
            indexed_files
                .iter()
                .filter(|file| file.index_reused)
                .count(),
            indexed_files
                .iter()
                .filter(|file| !file.index_reused)
                .count(),
        );
        Ok(Self {
            root,
            compatibility: CompatibilityIdentity::default(),
            manifest: None,
            indexed_files,
            revision,
            embedded_resources: BTreeMap::new(),
            packaged_project: None,
            runtime_manifest_sparse: false,
            pending_reload: None,
            source_index_stats,
        })
    }

    pub fn from_project_file(path: &Path) -> Result<Self, String> {
        // Match the storage partition used by earlier releases, which hashed the path returned by
        // the native picker before canonicalizing it for filesystem access.
        let packaged_storage_key = packaged_project_storage_key(path);
        let path = path
            .canonicalize()
            .map_err(|error| format!("cannot open project file: {error}"))?;
        if !path.is_file()
            || !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("reraproj"))
        {
            return Err("selected path is not a .reraproj file".into());
        }
        let decoded = decode_packaged_project(&path, None)?;
        let indexed_files = decoded
            .project
            .manifest
            .files
            .iter()
            .map(indexed_file)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            root: path.parent().unwrap_or_else(|| Path::new(".")).to_owned(),
            compatibility: decoded.project.identity.compatibility.clone(),
            manifest: None,
            indexed_files,
            revision: decoded.project.identity.project_revision,
            embedded_resources: BTreeMap::new(),
            packaged_project: Some(PackagedProjectFile {
                path,
                storage_key: packaged_storage_key,
                file_digest: decoded.file_digest,
            }),
            runtime_manifest_sparse: true,
            pending_reload: None,
            source_index_stats: (0, 0),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve_compatibility(
        &mut self,
        session: &era_web_bridge::WebSession,
    ) -> Result<(), String> {
        let configuration = if let Some(package) = &self.packaged_project {
            decode_packaged_project(&package.path, None)?
                .project
                .manifest
                .files
                .into_iter()
                .find(|file| file.relative_path.eq_ignore_ascii_case("reraconfig.toml"))
        } else if let Some(indexed) = self
            .indexed_files
            .iter()
            .find(|file| file.relative_path.eq_ignore_ascii_case("reraconfig.toml"))
        {
            let (file, _) = stable_read_file(
                &self.root,
                &self.root.join(&indexed.relative_path),
                FileCategory::Configuration,
            )?;
            if file.content_hash.as_ref().map(ProtocolBytes::as_slice)
                != Some(indexed.content_hash.as_slice())
            {
                return Err(
                    "project configuration changed after scanning; reopen the project".into(),
                );
            }
            Some(file)
        } else {
            for entry in fs::read_dir(&self.root).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("reraconfig.toml")
                {
                    return Err(
                        "project configuration appeared after scanning; reopen the project".into(),
                    );
                }
            }
            None
        };
        let report = session.resolve_project_compatibility(configuration)?;
        let compatibility = report.identity.ok_or_else(|| {
            report
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.message.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })?;
        if self.packaged_project.is_some() && self.compatibility != compatibility {
            return Err(
                "packaged project compatibility does not match its root configuration".into(),
            );
        }
        self.compatibility = compatibility;
        if let Some(manifest) = &mut self.manifest {
            manifest.compatibility = self.compatibility.clone();
        }
        Ok(())
    }

    pub fn runtime_storage_root(&self) -> PathBuf {
        let root = self.runtime_save_root();
        if self.compatibility.profile == CompatibilityProfileId::EmueraSkiaSnake {
            root.join(".rustyera/profiles/emuera.skia.snake")
        } else {
            root
        }
    }

    pub fn runtime_save_root(&self) -> PathBuf {
        self.packaged_project.as_ref().map_or_else(
            || self.root.clone(),
            |project| {
                self.root
                    .join(".rustyera/packaged-projects")
                    .join(&project.storage_key)
            },
        )
    }

    pub(crate) fn compiled_cache_path(&self) -> PathBuf {
        if self.packaged_project.is_some() {
            self.runtime_storage_root()
                .join("cache")
                .join(COMPILED_CACHE_NAME)
        } else {
            self.runtime_storage_root()
                .join(".rustyera/cache")
                .join(COMPILED_CACHE_NAME)
        }
    }

    pub fn source_index_stats(&self) -> (usize, usize) {
        self.source_index_stats
    }

    pub fn font_sources(&self) -> Vec<ProjectFontSource> {
        self.indexed_files
            .iter()
            .filter(|file| is_project_font_path(&file.relative_path))
            .map(|file| ProjectFontSource {
                relative_path: file.relative_path.clone(),
                content_hash: file.content_hash.to_vec(),
                byte_length: file.byte_length,
            })
            .collect()
    }

    pub fn read_font(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        let file = self
            .indexed_files
            .iter()
            .find(|file| {
                file.relative_path.eq_ignore_ascii_case(relative_path)
                    && is_project_font_path(&file.relative_path)
            })
            .ok_or_else(|| "unknown project font".to_owned())?;
        if file.byte_length > MAXIMUM_PROJECT_FONT_BYTES {
            return Err("project font exceeds the native host memory budget".into());
        }
        if self.packaged_project.is_some() {
            return self.read_packaged_resource(relative_path, None);
        }
        if let Some(bytes) = self
            .embedded_resources
            .get(&file.relative_path.to_lowercase())
        {
            return Ok(bytes.clone());
        }
        let path = file
            .source_path
            .as_deref()
            .map_or_else(|| self.root.join(&file.relative_path), Path::to_owned);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("cannot stat project font {}: {error}", path.display()))?;
        if metadata.len() != file.byte_length || metadata.len() > MAXIMUM_PROJECT_FONT_BYTES {
            return Err(format!(
                "project font length changed after scan: {}",
                file.relative_path
            ));
        }
        if file
            .source_signature
            .is_some_and(|signature| metadata_signature(&metadata) != signature)
        {
            return Err(format!(
                "project font changed after scan: {}",
                file.relative_path
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("cannot read project font {}: {error}", path.display()))?;
        if blake3::hash(&bytes).as_bytes() != &file.content_hash {
            return Err(format!(
                "project font changed after scan: {}",
                file.relative_path
            ));
        }
        Ok(bytes)
    }

    pub fn mark_runtime_manifest_sparse(&mut self) {
        self.manifest = None;
        self.runtime_manifest_sparse = true;
    }

    pub fn mark_runtime_manifest_complete(&mut self) {
        self.manifest = None;
        self.runtime_manifest_sparse = false;
    }

    pub fn write_configuration(
        &mut self,
        expected_digest: &[u8],
        contents: &str,
    ) -> Result<(), String> {
        if let Some(project_file) = self
            .packaged_project
            .as_ref()
            .map(|project| project.path.clone())
        {
            return self.write_packaged_configuration(&project_file, expected_digest, contents);
        }
        let relative_path = self
            .indexed_files
            .iter()
            .find(|file| file.relative_path.eq_ignore_ascii_case("reraconfig.toml"))
            .map_or_else(
                || "reraconfig.toml".to_owned(),
                |file| file.relative_path.clone(),
            );
        let target = self.root.join(&relative_path);
        let current_digest =
            match normalized_file_bytes(&target, &relative_path, FileCategory::Configuration) {
                Ok(bytes) => {
                    let text = String::from_utf8(bytes)
                        .map_err(|_| "reraconfig.toml is not valid UTF-8".to_owned())?;
                    blake3::hash(normalize_configuration_text(&text).as_bytes())
                        .as_bytes()
                        .to_vec()
                }
                Err(_) if !target.exists() => Vec::new(),
                Err(error) => return Err(error),
            };
        let normalized_contents = contents.replace("\r\n", "\n").replace('\r', "\n");
        let requested_digest = blake3::hash(normalized_contents.as_bytes());
        if current_digest == requested_digest.as_bytes() {
            return Ok(());
        }
        if current_digest != expected_digest {
            return Err("reraconfig.toml 已被其他程序修改，请重新打开偏好设置".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)
            .map_err(|error| format!("cannot create temporary configuration file: {error}"))?;
        temporary
            .write_all(native_configuration_contents(contents).as_bytes())
            .map_err(|error| format!("cannot write configuration file: {error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("cannot sync configuration file: {error}"))?;
        temporary
            .persist(&target)
            .map_err(|error| format!("cannot replace configuration file: {}", error.error))?;
        self.refresh_configuration_index(
            &relative_path,
            target,
            normalized_contents,
            *requested_digest.as_bytes(),
        );
        Ok(())
    }

    fn write_packaged_configuration(
        &mut self,
        project_file: &Path,
        expected_digest: &[u8],
        contents: &str,
    ) -> Result<(), String> {
        let project_bytes =
            fs::read(project_file).map_err(|error| format!("cannot read project file: {error}"))?;
        let update = era_runtime::prepare_project_configuration_update(
            &project_bytes,
            project_bytes
                .len()
                .saturating_add(PROJECT_CONFIGURATION_UPDATE_HEADROOM),
            expected_digest,
            contents,
        )
        .map_err(|error| error.to_string())?;
        let mut target = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(project_file)
            .map_err(|error| format!("cannot open project file for update: {error}"))?;
        let expected_file_hash = blake3::hash(&project_bytes);
        let mut current_hasher = blake3::Hasher::new();
        let mut hash_buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = target
                .read(&mut hash_buffer)
                .map_err(|error| format!("cannot verify project file: {error}"))?;
            if read == 0 {
                break;
            }
            current_hasher.update(&hash_buffer[..read]);
        }
        if current_hasher.finalize() != expected_file_hash {
            return Err("项目文件已被其他程序修改，请重新打开偏好设置".into());
        }
        target
            .set_len(update.truncate_to)
            .map_err(|error| format!("cannot recover project configuration tail: {error}"))?;
        target
            .seek(SeekFrom::Start(update.truncate_to))
            .map_err(|error| format!("cannot seek project configuration tail: {error}"))?;
        target
            .write_all(&update.append)
            .map_err(|error| format!("cannot append project configuration: {error}"))?;
        target
            .sync_all()
            .map_err(|error| format!("cannot sync project configuration: {error}"))?;
        drop(target);
        drop(project_bytes);
        let updated_file_digest = decode_packaged_project(project_file, None)?.file_digest;
        self.packaged_project
            .as_mut()
            .expect("packaged project disappeared during configuration update")
            .file_digest = updated_file_digest;
        self.invalidate_compiled_cache();
        Ok(())
    }

    fn refresh_configuration_index(
        &mut self,
        relative_path: &str,
        source_path: PathBuf,
        contents: String,
        content_hash: [u8; 32],
    ) {
        let source_signature = fs::metadata(&source_path)
            .ok()
            .map(|metadata| metadata_signature(&metadata));
        let byte_length = contents.len() as u64;
        let pending_file = SubmittedFile {
            relative_path: relative_path.to_owned(),
            category: FileCategory::Configuration,
            payload: FilePayload::Utf8(contents),
            content_hash: Some(ProtocolBytes::new(content_hash.to_vec())),
        };
        let updated = IndexedFile {
            relative_path: relative_path.to_owned(),
            source_path: Some(source_path),
            category: FileCategory::Configuration,
            content_hash,
            byte_length,
            pending_file: Some(pending_file),
            source_signature,
            index_reused: false,
        };
        if let Some(index) = self
            .indexed_files
            .iter()
            .position(|file| file.relative_path.eq_ignore_ascii_case(relative_path))
        {
            self.indexed_files[index] = updated;
        } else {
            self.indexed_files.push(updated);
            self.indexed_files.sort_by(|left, right| {
                left.relative_path
                    .to_lowercase()
                    .cmp(&right.relative_path.to_lowercase())
                    .then_with(|| left.relative_path.cmp(&right.relative_path))
            });
        }
        self.manifest = None;
    }
}
