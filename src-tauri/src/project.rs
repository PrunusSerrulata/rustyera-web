use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;
use std::time::{Duration, Instant};

use encoding_rs::{GBK, SHIFT_JIS, UTF_8};
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FileChange, FilePayload, ProjectIdentity, ProjectManifest, ReloadProject,
    SubmittedFile, validate_relative_path,
};

const PROJECT_CONFIGURATION_UPDATE_HEADROOM: usize = 1024 * 1024;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use walkdir::{DirEntry, WalkDir};

const RESOURCE_SUFFIXES: &[&str] = &[
    "bmp", "gif", "jpeg", "jpg", "png", "webp", "wav", "mp3", "ogg", "opus", "aac", "m4a", "flac",
];
const AUDIO_SUFFIXES: &[&str] = &["wav", "mp3", "ogg", "opus", "aac", "m4a", "flac"];
const FONT_SUFFIXES: &[&str] = &["otf", "ttc", "ttf", "woff", "woff2"];
const SOURCE_INDEX_VERSION: u32 = 1;
const COMPILED_CACHE_NAME: &str = "compiled-project.reracache";
const STABLE_SCAN_ATTEMPTS: usize = 3;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(34);

#[derive(Clone)]
struct IndexedFile {
    relative_path: String,
    source_path: Option<PathBuf>,
    category: FileCategory,
    content_hash: [u8; 32],
    pending_file: Option<SubmittedFile>,
    source_signature: Option<[u64; 5]>,
}

struct PendingProjectReload {
    indexed_files: Vec<IndexedFile>,
    manifest: ProjectManifest,
    runtime_manifest_sparse: bool,
}

#[derive(Default, Deserialize, Serialize)]
struct SourceIndex {
    version: u32,
    files: BTreeMap<String, SourceIndexEntry>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
struct SourceIndexEntry {
    category: u8,
    signature: [u64; 5],
    hash: String,
    size: u64,
}

pub struct ProjectHost {
    root: PathBuf,
    manifest: Option<ProjectManifest>,
    indexed_files: Vec<IndexedFile>,
    revision: u64,
    embedded_resources: BTreeMap<String, Vec<u8>>,
    project_file: Option<PathBuf>,
    runtime_manifest_sparse: bool,
    pending_reload: Option<PendingProjectReload>,
    source_index_stats: (usize, usize),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFontSource {
    pub relative_path: String,
    pub content_hash: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProjectReloadScope {
    All,
    Folder { path: String },
    Script { path: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReloadTargets {
    pub folders: Vec<String>,
    pub scripts: Vec<String>,
}

enum ProjectReloadSelector {
    All,
    Folder(String),
    Script(String),
}

impl ProjectReloadSelector {
    fn new(scope: &ProjectReloadScope) -> Result<Self, String> {
        let normalize = |path: &str| {
            validate_relative_path(path)
                .map(|path| path.trim_end_matches('/').to_owned())
                .map_err(|error| error.to_string())
        };
        match scope {
            ProjectReloadScope::All => Ok(Self::All),
            ProjectReloadScope::Folder { path } => Ok(Self::Folder(normalize(path)?)),
            ProjectReloadScope::Script { path } => Ok(Self::Script(normalize(path)?)),
        }
    }

    fn matches(&self, relative_path: &str, category: FileCategory) -> bool {
        if matches!(self, Self::All) {
            return true;
        }
        if !matches!(category, FileCategory::Erb | FileCategory::Erh) {
            return false;
        }
        match self {
            Self::All => true,
            Self::Folder(path) => {
                relative_path == path || relative_path.starts_with(&format!("{path}/"))
            }
            Self::Script(path) => relative_path == path,
        }
    }
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
        let root = root
            .canonicalize()
            .map_err(|error| format!("cannot open project directory: {error}"))?;
        if !root.is_dir() {
            return Err("selected project path is not a directory".into());
        }
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
            indexed_files: files
                .iter()
                .map(indexed_file)
                .collect::<Result<Vec<_>, _>>()?,
            manifest: Some(ProjectManifest {
                project_revision: revision,
                files,
            }),
            revision,
            embedded_resources: BTreeMap::new(),
            project_file: None,
            runtime_manifest_sparse: false,
            pending_reload: None,
            source_index_stats: (0, file_count),
        })
    }

    #[cfg(test)]
    pub fn scan_quick(root: &Path, revision: u64) -> Result<Self, String> {
        Self::scan_quick_with_progress(root, revision, None)
    }

    pub fn scan_quick_with_progress(
        root: &Path,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<Self, String> {
        if let Some(progress) = progress {
            progress(0, 0);
        }
        let root = root
            .canonicalize()
            .map_err(|error| format!("cannot open project directory: {error}"))?;
        if !root.is_dir() {
            return Err("selected project path is not a directory".into());
        }
        retry_stable_scan(|| Self::scan_quick_once(root.clone(), revision, progress))
    }

    fn scan_quick_once(
        root: PathBuf,
        revision: u64,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<Self, String> {
        type IndexedScanResult = (IndexedFile, SourceIndexEntry);

        let index_path = root.join(".rustyera/cache/source-index-v1.json");
        let stored_index = fs::read(&index_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SourceIndex>(&bytes).ok())
            .filter(|index| index.version == SOURCE_INDEX_VERSION);
        let previous = stored_index
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
        if stored_index.is_none() || previous != next_index {
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
                .filter(|file| file.pending_file.is_none())
                .count(),
            indexed_files
                .iter()
                .filter(|file| file.pending_file.is_some())
                .count(),
        );
        Ok(Self {
            root,
            manifest: None,
            indexed_files,
            revision,
            embedded_resources: BTreeMap::new(),
            project_file: None,
            runtime_manifest_sparse: false,
            pending_reload: None,
            source_index_stats,
        })
    }

    pub fn from_project_file(path: &Path, bytes: &[u8]) -> Result<Self, String> {
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
        let decoded = era_runtime::decode_project_file(bytes, bytes.len())
            .map_err(|error| error.to_string())?;
        let indexed_files = decoded
            .manifest
            .files
            .iter()
            .map(indexed_file)
            .collect::<Result<Vec<_>, _>>()?;
        let embedded_resources = decoded
            .manifest
            .files
            .iter()
            .filter_map(|file| match (&file.category, &file.payload) {
                (FileCategory::Resource, FilePayload::Bytes(bytes)) => {
                    Some((file.relative_path.to_lowercase(), bytes.as_slice().to_vec()))
                }
                _ => None,
            })
            .collect();
        Ok(Self {
            root: path.parent().unwrap_or_else(|| Path::new(".")).to_owned(),
            manifest: Some(decoded.manifest),
            indexed_files,
            revision: decoded.identity.project_revision,
            embedded_resources,
            project_file: Some(path),
            runtime_manifest_sparse: false,
            pending_reload: None,
            source_index_stats: (0, 0),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
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
        fs::read(&path)
            .map_err(|error| format!("cannot read project font {}: {error}", path.display()))
    }

    pub fn mark_runtime_manifest_sparse(&mut self) {
        self.runtime_manifest_sparse = true;
    }

    pub fn write_configuration(
        &mut self,
        expected_digest: &[u8],
        contents: &str,
    ) -> Result<(), String> {
        if let Some(project_file) = &self.project_file {
            let project_bytes = fs::read(project_file)
                .map_err(|error| format!("cannot read project file: {error}"))?;
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
            let mut current_bytes = Vec::with_capacity(project_bytes.len());
            target
                .read_to_end(&mut current_bytes)
                .map_err(|error| format!("cannot verify project file: {error}"))?;
            if blake3::hash(&current_bytes) != blake3::hash(&project_bytes) {
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
            return Ok(());
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
            pending_file: Some(pending_file),
            source_signature,
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

    pub fn invalidate_compiled_cache(&self) {
        if self.project_file.is_none() {
            let _ = fs::remove_file(self.root.join(".rustyera/cache").join(COMPILED_CACHE_NAME));
        }
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

    pub fn retained_manifest_with_progress(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<ProjectManifest, String> {
        self.materialize_with_progress(progress)?;
        self.manifest
            .clone()
            .ok_or_else(|| "project manifest was not materialized".to_owned())
    }

    pub fn compiled_cache(&self) -> Result<Option<Vec<u8>>, String> {
        let path = self.root.join(".rustyera/cache").join(COMPILED_CACHE_NAME);
        match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("cannot read compiled project cache: {error}")),
        }
    }

    pub fn project_reload_targets(&self) -> Result<ProjectReloadTargets, String> {
        if self.project_file.is_some() {
            return Ok(ProjectReloadTargets {
                folders: Vec::new(),
                scripts: Vec::new(),
            });
        }
        let canonical_roots = canonical_source_roots(&self.root)?;
        let mut scripts = self
            .indexed_files
            .iter()
            .filter(|file| matches!(file.category, FileCategory::Erb | FileCategory::Erh))
            .map(|file| file.relative_path.clone())
            .collect::<BTreeSet<_>>();
        for (path, category) in project_entries(&self.root, &canonical_roots)? {
            if matches!(category, FileCategory::Erb | FileCategory::Erh) {
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
        if self.project_file.is_some() {
            return Err("a packaged project cannot reload source files".into());
        }
        if self.pending_reload.is_some() {
            return Err("a project reload is already awaiting runtime confirmation".into());
        }
        let selector = ProjectReloadSelector::new(scope)?;
        let candidate =
            Self::scan_with_progress(&self.root, self.revision.saturating_add(1), progress)?;
        if self.runtime_manifest_sparse && !matches!(&selector, ProjectReloadSelector::All) {
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
        let changes =
            if self.runtime_manifest_sparse && matches!(&selector, ProjectReloadSelector::All) {
                new_manifest
                    .files
                    .iter()
                    .cloned()
                    .map(|file| FileChange::Upsert { file })
                    .collect()
            } else {
                paths
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
                    .collect()
            };
        let request = ReloadProject {
            base_revision: self.revision,
            target_revision: candidate.revision,
            changes,
        };
        let (indexed_files, manifest, runtime_manifest_sparse) =
            if matches!(&selector, ProjectReloadSelector::All) {
                (candidate.indexed_files.clone(), new_manifest.clone(), false)
            } else {
                (
                    self.merged_scoped_index(&selector, &candidate),
                    ProjectManifest {
                        project_revision: candidate.revision,
                        files: self.merged_scoped_files(&selector, &candidate)?,
                    },
                    false,
                )
            };
        self.pending_reload = Some(PendingProjectReload {
            indexed_files,
            manifest,
            runtime_manifest_sparse,
        });
        Ok(request)
    }

    fn hydrate_sparse_reload(
        &mut self,
        selector: &ProjectReloadSelector,
        candidate: Self,
    ) -> Result<ReloadProject, String> {
        let baseline = self.active_manifest()?;
        let files = self.merged_scoped_files(selector, &candidate)?;
        let hydrated_paths = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<BTreeSet<_>>();
        let mut changes = files
            .iter()
            .cloned()
            .map(|file| FileChange::Upsert { file })
            .collect::<Vec<_>>();
        changes.extend(
            baseline
                .files
                .iter()
                .filter(|file| {
                    selector.matches(&file.relative_path, file.category)
                        && !hydrated_paths.contains(file.relative_path.as_str())
                })
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
        let manifest = ProjectManifest {
            project_revision: candidate.revision,
            files,
        };
        self.pending_reload = Some(PendingProjectReload {
            indexed_files: self.merged_scoped_index(selector, &candidate),
            manifest,
            runtime_manifest_sparse: false,
        });
        Ok(request)
    }

    fn active_manifest(&self) -> Result<&ProjectManifest, String> {
        self.manifest
            .as_ref()
            .ok_or_else(|| "active project manifest was not retained".to_owned())
    }

    fn merged_scoped_files(
        &self,
        selector: &ProjectReloadSelector,
        candidate: &Self,
    ) -> Result<Vec<SubmittedFile>, String> {
        let baseline = self.active_manifest()?;
        let candidate_manifest = candidate
            .manifest
            .as_ref()
            .ok_or_else(|| "candidate manifest was not materialized".to_owned())?;
        let mut files = baseline
            .files
            .iter()
            .filter(|file| !selector.matches(&file.relative_path, file.category))
            .cloned()
            .chain(
                candidate_manifest
                    .files
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
        Ok(files)
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
            return;
        }
        self.indexed_files = pending.indexed_files;
        self.revision = pending.manifest.project_revision;
        self.manifest = Some(pending.manifest);
        self.runtime_manifest_sparse = pending.runtime_manifest_sparse;
    }

    pub fn read_resource(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        if let Some(bytes) = self.embedded_resources.get(&relative_path.to_lowercase()) {
            return Ok(bytes.clone());
        }
        fs::read(self.resource_path(relative_path)?)
            .map_err(|error| format!("cannot read resource: {error}"))
    }

    pub fn read_resource_prefix(
        &self,
        relative_path: &str,
        maximum_bytes: u32,
    ) -> Result<Vec<u8>, String> {
        if let Some(bytes) = self.embedded_resources.get(&relative_path.to_lowercase()) {
            return Ok(bytes[..bytes.len().min(maximum_bytes as usize)].to_vec());
        }
        let path = self.resource_path(relative_path)?;
        let file =
            fs::File::open(path).map_err(|error| format!("cannot open resource: {error}"))?;
        let mut bytes = Vec::with_capacity(maximum_bytes as usize);
        file.take(u64::from(maximum_bytes))
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read resource header: {error}"))?;
        Ok(bytes)
    }

    fn resource_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        let relative = validate_relative_path(relative_path).map_err(|error| error.to_string())?;
        let path = self.root.join(relative);
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("cannot open resource: {error}"))?;
        if canonical != self.root && !canonical.starts_with(&self.root) {
            return Err("resource path escapes the project root".into());
        }
        Ok(canonical)
    }
}

fn project_entries(
    root: &Path,
    canonical_roots: &BTreeSet<String>,
) -> Result<Vec<(PathBuf, FileCategory)>, String> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(true)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(include_entry)
    {
        let entry = entry.map_err(|error| format!("cannot scan project: {error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(category) = classify(root, entry.path(), canonical_roots)? {
            entries.push((entry.into_path(), category));
        }
    }
    Ok(entries)
}

struct ProgressGate<'a> {
    callback: Option<&'a dyn Fn(usize, usize)>,
    last: Option<(usize, usize)>,
    last_emitted: Instant,
}

impl<'a> ProgressGate<'a> {
    fn new(callback: Option<&'a dyn Fn(usize, usize)>) -> Self {
        Self {
            callback,
            last: None,
            last_emitted: Instant::now(),
        }
    }

    fn report(&mut self, completed: usize, total: usize) {
        let value = (completed, total);
        if self.last == Some(value) {
            return;
        }
        let boundary = completed == 0 || completed >= total;
        if boundary || self.last_emitted.elapsed() >= PROGRESS_INTERVAL {
            if let Some(callback) = self.callback {
                callback(completed, total);
            }
            self.last = Some(value);
            self.last_emitted = Instant::now();
        }
    }
}

fn parallel_ordered<T: Send>(
    total: usize,
    progress: Option<&dyn Fn(usize, usize)>,
    cancelled: Option<&AtomicBool>,
    operation: impl Fn(usize) -> Result<T, String> + Sync,
) -> Result<Vec<T>, String> {
    if total == 0 {
        return Ok(Vec::new());
    }
    let workers = thread::available_parallelism()
        .map_or(1, std::num::NonZero::get)
        .min(8)
        .min(total);
    let next = AtomicUsize::new(0);
    let mut ordered = (0..total).map(|_| None).collect::<Vec<_>>();
    thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        for _ in 0..workers {
            let sender = sender.clone();
            let operation = &operation;
            let next = &next;
            scope.spawn(move || {
                loop {
                    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= total {
                        break;
                    }
                    if sender.send((index, operation(index))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);
        let mut gate = ProgressGate::new(progress);
        for (completed, (index, result)) in receiver.into_iter().enumerate() {
            ordered[index] = Some(result);
            gate.report(completed + 1, total);
        }
    });
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err("full project export cancelled".into());
    }
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            result.ok_or_else(|| format!("project file reader omitted entry {index}"))?
        })
        .collect()
}

fn indexed_file(file: &SubmittedFile) -> Result<IndexedFile, String> {
    let digest = file
        .content_hash
        .as_ref()
        .ok_or_else(|| format!("{} has no content hash", file.relative_path))?;
    let content_hash: [u8; 32] = digest
        .as_slice()
        .try_into()
        .map_err(|_| format!("{} has an invalid content hash", file.relative_path))?;
    Ok(IndexedFile {
        relative_path: file.relative_path.clone(),
        source_path: None,
        category: file.category,
        content_hash,
        pending_file: None,
        source_signature: None,
    })
}

fn canonical_source_roots(root: &Path) -> Result<BTreeSet<String>, String> {
    Ok(fs::read_dir(root)
        .map_err(|error| format!("cannot enumerate project directory: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .filter(|name| name == "csv" || name == "erb")
        .collect())
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| "project path escaped its root".to_owned())?
        .to_string_lossy()
        .replace('\\', "/")
        .nfc()
        .collect())
}

fn normalized_file_bytes(
    path: &Path,
    relative_path: &str,
    category: FileCategory,
) -> Result<Vec<u8>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if category == FileCategory::Resource {
        return Ok(bytes);
    }
    normalized_project_text(relative_path, &bytes, category)
        .map(String::into_bytes)
        .ok_or_else(|| format!("{} is not valid UTF-8, Windows-31J, or GBK", path.display()))
}

fn normalize_resource_manifest(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut start = 0;
    while start < text.len() {
        let ending_start = text[start..]
            .char_indices()
            .find_map(|(offset, value)| matches!(value, '\r' | '\n').then_some(start + offset))
            .unwrap_or(text.len());
        let ending_end = if text[ending_start..].starts_with("\r\n") {
            ending_start + 2
        } else if ending_start < text.len() {
            ending_start + 1
        } else {
            ending_start
        };
        normalized.push_str(&normalize_resource_manifest_line(
            &text[start..ending_start],
        ));
        normalized.push_str(&text[ending_start..ending_end]);
        start = ending_end;
    }
    normalized
}

fn normalize_resource_manifest_line(line: &str) -> String {
    let mut fields = line.split(',').map(str::to_owned).collect::<Vec<_>>();
    let replacement = fields.get(1).and_then(|value| {
        let trimmed = value.trim_matches([' ', '\t']);
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("anime") {
            let leading_bytes = value.len() - value.trim_start_matches([' ', '\t']).len();
            let trailing_start = value.trim_end_matches([' ', '\t']).len();
            let path = trimmed.nfc().collect::<String>();
            Some(format!(
                "{}{}{}",
                &value[..leading_bytes],
                path,
                &value[trailing_start..]
            ))
        } else {
            None
        }
    });
    if let Some(replacement) = replacement {
        fields[1] = replacement;
    }
    fields.join(",")
}

fn normalized_project_text(
    relative_path: &str,
    bytes: &[u8],
    category: FileCategory,
) -> Option<String> {
    let text = if relative_path.eq_ignore_ascii_case("reraconfig.toml") {
        std::str::from_utf8(bytes)
            .ok()
            .map(|text| text.strip_prefix('\u{feff}').unwrap_or(text).to_owned())
    } else {
        decode_project_text(bytes)
    }?;
    Some(if category == FileCategory::ResourceManifest {
        normalize_resource_manifest(&text)
    } else {
        text
    })
}

fn decode_project_text(bytes: &[u8]) -> Option<String> {
    for encoding in [UTF_8, SHIFT_JIS, GBK] {
        if let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(bytes) {
            return Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned());
        }
    }
    None
}

fn metadata_signature(metadata: &fs::Metadata) -> [u64; 5] {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mtime = u64::try_from(metadata.mtime())
            .unwrap_or_default()
            .saturating_mul(1_000_000_000)
            .saturating_add(u64::try_from(metadata.mtime_nsec()).unwrap_or_default());
        let ctime = u64::try_from(metadata.ctime())
            .unwrap_or_default()
            .saturating_mul(1_000_000_000)
            .saturating_add(u64::try_from(metadata.ctime_nsec()).unwrap_or_default());
        [metadata.len(), mtime, ctime, metadata.dev(), metadata.ino()]
    }
    #[cfg(not(unix))]
    {
        let modified = metadata.modified().map_or(0, |modified| {
            modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        });
        [
            metadata.len(),
            u64::try_from(modified).unwrap_or(u64::MAX),
            0,
            0,
            0,
        ]
    }
}

fn write_source_index(path: &Path, index: &SourceIndex) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "source index path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create source index directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("cannot create temporary source index: {error}"))?;
    serde_json::to_writer(&mut temporary, index)
        .map_err(|error| format!("cannot encode source index: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("cannot sync source index: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("cannot replace source index: {}", error.error))?;
    Ok(())
}

fn encode_hash(hash: &[u8; 32]) -> String {
    let mut result = String::with_capacity(64);
    for byte in hash {
        write!(result, "{byte:02x}").expect("writing to a String cannot fail");
    }
    result
}

fn decode_hash(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("source index contains an invalid content hash".into());
    }
    let mut result = [0; 32];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "source index contains an invalid content hash".to_owned())?;
    }
    Ok(result)
}

fn by_path(manifest: &ProjectManifest) -> BTreeMap<&str, &SubmittedFile> {
    manifest
        .files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect()
}

fn indexed_by_path(files: &[IndexedFile]) -> BTreeMap<&str, &IndexedFile> {
    files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect()
}

fn include_entry(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || !entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(".rustyera")
}

fn classify(
    root: &Path,
    path: &Path,
    canonical_roots: &BTreeSet<String>,
) -> Result<Option<FileCategory>, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "project path escaped its root".to_owned())?;
    let first = relative
        .components()
        .next()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if matches!(name.as_str(), "reraconfig.toml" | "setting.json") {
        return Ok(Some(FileCategory::Configuration));
    }
    if first == "resources" {
        return Ok(if extension == "csv" {
            Some(FileCategory::ResourceManifest)
        } else if RESOURCE_SUFFIXES.contains(&extension.as_str()) {
            Some(FileCategory::Resource)
        } else {
            None
        });
    }
    if first == "sound" {
        return Ok(AUDIO_SUFFIXES
            .contains(&extension.as_str())
            .then_some(FileCategory::Resource));
    }
    if first == "font" {
        return Ok(FONT_SUFFIXES
            .contains(&extension.as_str())
            .then_some(FileCategory::Resource));
    }
    let category = match extension.as_str() {
        "csv" => FileCategory::Csv,
        "erh" => FileCategory::Erh,
        "erb" => FileCategory::Erb,
        "config" => FileCategory::Configuration,
        _ => return Ok(None),
    };
    if matches!(category, FileCategory::Erh | FileCategory::Erb)
        && canonical_roots.contains("erb")
        && first != "erb"
    {
        return Ok(None);
    }
    if category == FileCategory::Csv && canonical_roots.contains("csv") && first != "csv" {
        return Ok(None);
    }
    if category == FileCategory::Configuration
        && canonical_roots.contains("csv")
        && relative.components().count() > 1
        && first != "csv"
    {
        return Ok(None);
    }
    Ok(Some(category))
}

fn is_project_font_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let mut parts = normalized.split('/');
    let first = parts.next().unwrap_or_default();
    let extension = Path::new(&normalized)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    first.eq_ignore_ascii_case("font") && FONT_SUFFIXES.contains(&extension.as_str())
}

fn normalize_configuration_text(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn native_configuration_contents(contents: &str) -> String {
    let normalized = contents.replace("\r\n", "\n").replace('\r', "\n");
    #[cfg(windows)]
    {
        return normalized.replace('\n', "\r\n");
    }
    #[cfg(not(windows))]
    normalized
}

fn read_file(root: &Path, path: &Path, category: FileCategory) -> Result<SubmittedFile, String> {
    let relative_path = path
        .strip_prefix(root)
        .map_err(|_| "project path escaped its root".to_owned())?
        .to_string_lossy()
        .replace('\\', "/")
        .nfc()
        .collect::<String>();
    let bytes = fs::read(path).map_err(|error| format!("cannot read {relative_path}: {error}"))?;
    let (payload, content_hash) = if category == FileCategory::Resource {
        let content_hash = blake3::hash(&bytes);
        (FilePayload::Bytes(ProtocolBytes::new(bytes)), content_hash)
    } else {
        let text = normalized_project_text(&relative_path, &bytes, category).ok_or_else(|| {
            if relative_path.eq_ignore_ascii_case("reraconfig.toml") {
                format!("{relative_path} is not valid UTF-8")
            } else {
                format!("{relative_path} is not valid UTF-8, Windows-31J, or GBK")
            }
        })?;
        let content_hash = blake3::hash(text.as_bytes());
        (FilePayload::Utf8(text), content_hash)
    };
    Ok(SubmittedFile {
        relative_path,
        category,
        payload,
        content_hash: Some(ProtocolBytes::new(content_hash.as_bytes().to_vec())),
    })
}

fn materialize_indexed_file(root: &Path, indexed: &IndexedFile) -> Result<SubmittedFile, String> {
    let path = indexed
        .source_path
        .clone()
        .unwrap_or_else(|| root.join(&indexed.relative_path));
    let signature_matches = indexed.source_signature.is_some_and(|expected| {
        fs::metadata(&path).is_ok_and(|metadata| metadata_signature(&metadata) == expected)
    });
    if signature_matches {
        indexed.pending_file.clone().map_or_else(
            || stable_read_file(root, &path, indexed.category).map(|(file, _)| file),
            Ok,
        )
    } else {
        stable_read_file(root, &path, indexed.category).map(|(file, _)| file)
    }
}

fn stable_read_file(
    root: &Path,
    path: &Path,
    category: FileCategory,
) -> Result<(SubmittedFile, [u64; 5]), String> {
    let relative = relative_path(root, path)?;
    stable_read(
        &relative,
        || {
            fs::metadata(path)
                .map(|metadata| metadata_signature(&metadata))
                .map_err(|error| format!("cannot stat {relative}: {error}"))
        },
        || read_file(root, path, category),
    )
}

fn stable_read<T>(
    relative_path: &str,
    mut signature: impl FnMut() -> Result<[u64; 5], String>,
    mut read: impl FnMut() -> Result<T, String>,
) -> Result<(T, [u64; 5]), String> {
    for _ in 0..STABLE_SCAN_ATTEMPTS {
        let before = signature()?;
        let value = read()?;
        let after = signature()?;
        if before == after {
            return Ok((value, after));
        }
    }
    Err(format!(
        "{relative_path} changed repeatedly while it was being read"
    ))
}

fn retry_stable_scan<T>(mut scan: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    for _ in 0..STABLE_SCAN_ATTEMPTS {
        match scan() {
            Err(error) if error == "project changed while it was being scanned" => {}
            result => return result,
        }
    }
    Err("project changed repeatedly while it was being scanned".into())
}

fn scan_indexed_entry(
    root: &Path,
    path: &Path,
    category: FileCategory,
    previous: &BTreeMap<String, SourceIndexEntry>,
) -> Result<(IndexedFile, SourceIndexEntry), String> {
    let relative_path = relative_path(root, path)?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("cannot stat {relative_path}: {error}"))?;
    let signature = metadata_signature(&metadata);
    let prior = previous
        .get(&relative_path)
        .filter(|prior| prior.signature == signature && prior.category == category as u8)
        .and_then(|prior| decode_hash(&prior.hash).ok().map(|hash| (hash, prior.size)));
    let (content_hash, size, pending_file, signature) = if let Some((hash, size)) = prior {
        (hash, size, None, signature)
    } else {
        let (file, stable_signature) = stable_read_file(root, path, category)?;
        let content_hash = file
            .content_hash
            .as_ref()
            .and_then(|hash| hash.as_slice().try_into().ok())
            .ok_or_else(|| format!("{relative_path} has an invalid content hash"))?;
        let size = match &file.payload {
            FilePayload::Utf8(text) => text.len(),
            FilePayload::Bytes(bytes) => bytes.as_slice().len(),
            FilePayload::IoError(_) => 0,
        };
        (
            content_hash,
            u64::try_from(size).map_err(|_| format!("{relative_path} is too large"))?,
            Some(file),
            stable_signature,
        )
    };
    Ok((
        IndexedFile {
            relative_path,
            source_path: Some(path.to_owned()),
            category,
            content_hash,
            pending_file,
            source_signature: Some(signature),
        },
        SourceIndexEntry {
            category: category as u8,
            signature,
            hash: encode_hash(&content_hash),
            size,
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn supported_media_extensions_are_classified_as_resources() {
        let root = Path::new("/project");
        let canonical = BTreeSet::new();
        for extension in ["png", "webp", "wav", "mp3", "ogg", "m4a", "flac"] {
            let path = root.join(format!("resources/sample.{extension}"));
            assert_eq!(
                classify(root, &path, &canonical).unwrap(),
                Some(FileCategory::Resource)
            );
        }
    }

    #[test]
    fn sound_directory_audio_is_classified_as_a_resource() {
        let root = Path::new("/project");
        let canonical = BTreeSet::new();

        assert_eq!(
            classify(root, &root.join("sound/theme.mp3"), &canonical).unwrap(),
            Some(FileCategory::Resource)
        );
        assert_eq!(
            classify(root, &root.join("sound/cover.png"), &canonical).unwrap(),
            None
        );
    }

    #[test]
    fn font_directory_files_are_binary_resources_for_cross_frontend_exports() {
        let root = Path::new("/project");
        let canonical = BTreeSet::new();
        for extension in ["ttf", "otf", "ttc", "woff", "woff2"] {
            let path = root.join(format!("FoNt/sample.{extension}"));
            assert_eq!(
                classify(root, &path, &canonical).unwrap(),
                Some(FileCategory::Resource)
            );
        }
        assert_eq!(
            classify(root, &root.join("font/license.txt"), &canonical).unwrap(),
            None
        );
    }

    #[test]
    fn scanned_font_resources_remain_available_after_a_sparse_quick_scan() {
        let directory = tempfile::tempdir().unwrap();
        let fonts = directory.path().join("font");
        fs::create_dir(&fonts).unwrap();
        fs::write(fonts.join("Project.ttf"), b"font bytes").unwrap();
        fs::write(fonts.join("license.txt"), b"not packaged").unwrap();

        let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

        let resources = project.font_sources();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].relative_path, "font/Project.ttf");
        assert_eq!(
            resources[0].content_hash,
            blake3::hash(b"font bytes").as_bytes()
        );
        assert_eq!(
            project.read_font("font/Project.ttf").unwrap(),
            b"font bytes"
        );
    }

    #[test]
    fn resource_manifest_paths_are_normalized_to_nfc() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("resources");
        fs::create_dir(&resources).unwrap();
        fs::write(
            resources.join("sprites.csv"),
            "FACE, e\u{301}.png \r\nANIME,anime\n",
        )
        .unwrap();

        let project = ProjectHost::scan_with_progress(directory.path(), 1, None).unwrap();
        let manifest = project.manifest.as_ref().unwrap();
        let resource_manifest = manifest
            .files
            .iter()
            .find(|file| file.relative_path == "resources/sprites.csv")
            .unwrap();

        assert!(matches!(
            &resource_manifest.payload,
            FilePayload::Utf8(text) if text == "FACE, \u{e9}.png \r\nANIME,anime\n"
        ));
    }

    #[test]
    fn project_scan_matches_the_cross_frontend_cache_contract() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let resources = root.join("resources");
        let sound = root.join("sound");
        let fonts = root.join("font");
        let nested = root.join("sub");
        let private = root.join(".RUSTYERA/cache");
        for path in [&resources, &sound, &fonts, &nested, &private] {
            fs::create_dir_all(path).unwrap();
        }
        let decomposed = "e\u{301}.png";
        fs::write(resources.join(decomposed), b"png").unwrap();
        fs::write(
            resources.join("sprites.csv"),
            format!(
                "FACE, \t{decomposed} \t\r\nANIME, \tAnImE\t \nNOTE,\u{a0}{decomposed}\u{a0}\rMETA,a\u{85}b"
            ),
        )
        .unwrap();
        fs::write(sound.join("theme.MP3"), b"audio").unwrap();
        fs::write(fonts.join("Project.ttf"), b"font").unwrap();
        fs::write(sound.join("ignored.erb"), b"@IGNORED").unwrap();
        fs::write(private.join("ignored.erb"), b"@PRIVATE").unwrap();
        fs::write(root.join("reraconfig.toml"), b"[display]\nfont_size = 20\n").unwrap();
        fs::write(nested.join("reraconfig.toml"), b"\x82\xa0\n").unwrap();
        fs::write(root.join("\u{e9}.erb"), b"@ACCENTED\nRETURN\n").unwrap();
        fs::write(root.join("z.erb"), b"@ASCII\nRETURN\n").unwrap();

        let project = ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let manifest = project.manifest.as_ref().unwrap();

        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| (file.relative_path.as_str(), file.category))
                .collect::<Vec<_>>(),
            vec![
                ("font/Project.ttf", FileCategory::Resource),
                ("reraconfig.toml", FileCategory::Configuration),
                ("resources/sprites.csv", FileCategory::ResourceManifest),
                ("resources/\u{e9}.png", FileCategory::Resource),
                ("sound/theme.MP3", FileCategory::Resource),
                ("sub/reraconfig.toml", FileCategory::Configuration),
                ("z.erb", FileCategory::Erb),
                ("\u{e9}.erb", FileCategory::Erb),
            ]
        );
        assert!(matches!(
            &manifest.files[2].payload,
            FilePayload::Utf8(text)
                if text == "FACE, \t\u{e9}.png \t\r\nANIME, \tAnImE\t \nNOTE,\u{a0}\u{e9}.png\u{a0}\rMETA,a\u{85}b"
        ));
        assert!(matches!(
            &manifest.files[5].payload,
            FilePayload::Utf8(text) if text == "\u{3042}\n"
        ));
        let digest: [u8; 32] = project
            .identity()
            .source_digest
            .as_slice()
            .try_into()
            .unwrap();
        assert_eq!(
            encode_hash(&digest),
            "2554d3820c88d26cf3ddd33ba9896e9cc6397ce28669772cd0abd60539b2ae2b"
        );
        let mut quick = ProjectHost::scan_quick(root, 1).unwrap();
        assert_eq!(quick.identity(), project.identity());
        assert_eq!(
            era_web_bridge::project_identity(quick.materialize().unwrap()).unwrap(),
            project.identity()
        );
    }

    #[test]
    fn quick_scan_identity_matches_materialized_manifest_and_writes_an_index() {
        let directory = tempfile::tempdir().unwrap();
        let erb = directory.path().join("ERB");
        let csv = directory.path().join("CSV");
        fs::create_dir(&erb).unwrap();
        fs::create_dir(&csv).unwrap();
        fs::write(erb.join("sample.erb"), "\u{feff}@TEST\nRETURN").unwrap();
        fs::write(
            csv.join("_default.config"),
            b"\x91\xe5\x95\xb6\x8e\x9a:YES\r\n",
        )
        .unwrap();

        let mut quick = ProjectHost::scan_quick(directory.path(), 7).unwrap();
        let quick_identity = quick.identity();
        assert!(
            quick
                .indexed_files
                .iter()
                .all(|file| file.pending_file.is_some())
        );
        let materialized = quick.materialize().unwrap();

        assert_eq!(
            quick_identity,
            era_web_bridge::project_identity(materialized).unwrap()
        );
        assert!(materialized.files.iter().any(|file| {
            file.relative_path == "CSV/_default.config"
                && matches!(&file.payload, FilePayload::Utf8(text) if text == "大文字:YES\r\n")
        }));
        assert!(
            directory
                .path()
                .join(".rustyera/cache/source-index-v1.json")
                .is_file()
        );
    }

    #[test]
    fn full_project_materialization_honors_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let erb = directory.path().join("ERB");
        fs::create_dir(&erb).unwrap();
        fs::write(erb.join("main.erb"), "@MAIN\nRETURN\n").unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let cancelled = AtomicBool::new(true);

        assert_eq!(
            project
                .materialize_with_progress_and_cancel(None, Some(&cancelled))
                .unwrap_err(),
            "full project export cancelled"
        );
        assert!(project.manifest.is_none());
        assert_eq!(project.source_index_stats(), (0, 1));

        cancelled.store(false, Ordering::Relaxed);
        assert!(
            project
                .materialize_with_progress_and_cancel(None, Some(&cancelled))
                .is_ok()
        );
        assert_eq!(project.source_index_stats(), (0, 1));
    }

    #[test]
    fn parallel_reader_reports_the_lowest_input_error_deterministically() {
        let error = parallel_ordered(3, None, None, |index| {
            if index == 0 {
                thread::sleep(Duration::from_millis(20));
            }
            Err::<(), _>(format!("failure-{index}"))
        })
        .unwrap_err();

        assert_eq!(error, "failure-0");
    }

    #[test]
    fn progress_gate_deduplicates_and_emits_boundaries() {
        let observed = RefCell::new(Vec::new());
        let callback = |completed, total| observed.borrow_mut().push((completed, total));
        let mut gate = ProgressGate::new(Some(&callback));

        gate.report(0, 10);
        gate.report(0, 10);
        gate.report(1, 10);
        gate.last_emitted = Instant::now().checked_sub(PROGRESS_INTERVAL).unwrap();
        gate.report(2, 10);
        gate.report(10, 10);

        assert_eq!(observed.into_inner(), [(0, 10), (2, 10), (10, 10)]);
    }

    #[test]
    fn stable_read_retries_a_changed_signature_and_returns_the_matching_snapshot() {
        let signatures = RefCell::new(
            [
                [1, 0, 0, 0, 0],
                [2, 0, 0, 0, 0],
                [2, 0, 0, 0, 0],
                [2, 0, 0, 0, 0],
            ]
            .into_iter(),
        );
        let reads = RefCell::new(0);

        let (value, signature) = stable_read(
            "main.erb",
            || Ok(signatures.borrow_mut().next().unwrap()),
            || {
                *reads.borrow_mut() += 1;
                Ok(*reads.borrow())
            },
        )
        .unwrap();

        assert_eq!(value, 2);
        assert_eq!(signature, [2, 0, 0, 0, 0]);
    }

    #[test]
    fn stable_read_and_scan_fail_after_bounded_continuous_changes() {
        let counter = RefCell::new(0_u64);
        let read_error = stable_read(
            "main.erb",
            || {
                *counter.borrow_mut() += 1;
                Ok([*counter.borrow(), 0, 0, 0, 0])
            },
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(
            read_error,
            "main.erb changed repeatedly while it was being read"
        );

        let attempts = RefCell::new(0);
        let scan_error = retry_stable_scan(|| {
            *attempts.borrow_mut() += 1;
            Err::<(), _>("project changed while it was being scanned".to_owned())
        })
        .unwrap_err();
        assert_eq!(*attempts.borrow(), STABLE_SCAN_ATTEMPTS);
        assert_eq!(
            scan_error,
            "project changed repeatedly while it was being scanned"
        );
    }

    #[test]
    fn corrupt_source_index_is_rebuilt_from_file_contents() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("main.erb"), "@MAIN\nRETURN\n").unwrap();
        let index = directory
            .path()
            .join(".rustyera/cache/source-index-v1.json");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(&index, b"not-json").unwrap();

        let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

        assert_eq!(project.source_index_stats(), (0, 1));
        let stored: SourceIndex = serde_json::from_slice(&fs::read(index).unwrap()).unwrap();
        assert_eq!(stored.files.len(), 1);
    }

    #[test]
    fn complete_index_reuses_all_files_and_partial_change_hashes_only_one() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("a.erb");
        let second = directory.path().join("b.erb");
        fs::write(&first, "@A\nRETURN\n").unwrap();
        fs::write(&second, "@B\nRETURN\n").unwrap();
        ProjectHost::scan_quick(directory.path(), 1).unwrap();

        let reused = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        assert_eq!(reused.source_index_stats(), (2, 0));

        fs::write(&second, "@B\nPRINTL CHANGED\nRETURN\n").unwrap();
        let partial = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        assert_eq!(partial.source_index_stats(), (1, 1));
    }

    #[test]
    fn quick_scan_reads_the_real_path_while_submitting_an_nfc_protocol_path() {
        let directory = tempfile::tempdir().unwrap();
        let actual_name = "cafe\u{301}.erb";
        let actual_path = directory.path().join(actual_name);
        fs::write(&actual_path, "@SYSTEM_TITLE\nRETURN\n").unwrap();

        let mut quick = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let indexed = quick
            .indexed_files
            .iter()
            .find(|file| file.relative_path == "caf\u{e9}.erb")
            .unwrap();
        let canonical_actual = actual_path.canonicalize().unwrap();
        assert_eq!(
            indexed.source_path.as_deref(),
            Some(canonical_actual.as_path())
        );

        let manifest = quick.materialize().unwrap();
        assert!(
            manifest
                .files
                .iter()
                .any(|file| file.relative_path == "caf\u{e9}.erb")
        );
    }

    #[test]
    fn native_scan_reports_discovery_and_completed_file_counts() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("main.erb"), "@SYSTEM_TITLE\nRETURN\n").unwrap();
        fs::write(directory.path().join("variables.csv"), "FLAG,1\n").unwrap();
        let observed = RefCell::new(Vec::new());
        let progress = |completed, total| observed.borrow_mut().push((completed, total));

        ProjectHost::scan_quick_with_progress(directory.path(), 1, Some(&progress)).unwrap();

        let observed = observed.into_inner();
        assert_eq!(observed[..2], [(0, 0), (0, 2)]);
        assert_eq!(observed.last(), Some(&(2, 2)));
    }

    #[test]
    fn indexed_materialization_preserves_order_and_reports_each_file() {
        let directory = tempfile::tempdir().unwrap();
        for index in (0..16).rev() {
            fs::write(
                directory.path().join(format!("source-{index:02}.erb")),
                format!("@FUNCTION_{index}\nRETURN\n"),
            )
            .unwrap();
        }
        ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let mut indexed = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let observed = RefCell::new(Vec::new());
        let progress = |completed, total| observed.borrow_mut().push((completed, total));

        let manifest = indexed
            .retained_manifest_with_progress(Some(&progress))
            .unwrap();

        let paths = manifest
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(observed.borrow().last(), Some(&(16, 16)));
        assert_eq!(
            era_web_bridge::project_identity(&manifest).unwrap(),
            indexed.identity()
        );
    }

    #[test]
    fn quick_scan_rechecks_a_new_source_before_reusing_its_payload() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("main.erb");
        fs::write(&source, "@OLD\nRETURN\n").unwrap();
        let mut quick = ProjectHost::scan_quick(directory.path(), 1).unwrap();

        fs::write(&source, "@NEW-CONTENT\nRETURN\n").unwrap();

        assert!(
            quick
                .materialize()
                .unwrap_err()
                .contains("project changed while its source files were being loaded")
        );
    }

    #[test]
    fn reload_uses_the_indexed_baseline_after_a_file_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let fonts = directory.path().join("font");
        fs::create_dir(&fonts).unwrap();
        fs::write(directory.path().join("main.erb"), "@MAIN\nRETURN\n").unwrap();
        let removed = fonts.join("Project.ttf");
        fs::write(&removed, b"font bytes").unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

        fs::remove_file(removed).unwrap();
        let request = project
            .reload_scoped_with_progress(&ProjectReloadScope::All, None)
            .unwrap();

        assert_eq!(request.base_revision, 1);
        assert_eq!(request.target_revision, 2);
        assert_eq!(request.changes.len(), 1);
        assert!(matches!(
            &request.changes[0],
            FileChange::Remove {
                category: FileCategory::Resource,
                relative_path,
            } if relative_path == "font/Project.ttf"
        ));
        project.finalize_reload(true);
        assert!(project.font_sources().is_empty());
    }

    #[test]
    fn scoped_reload_retains_unselected_disk_changes_for_a_later_reload() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("ERB/selected");
        let other = directory.path().join("ERB/other");
        fs::create_dir_all(&selected).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(
            selected.join("command.erb"),
            "@COM0\nPRINTL OLD\nRETURN 1\n",
        )
        .unwrap();
        fs::write(other.join("command.erb"), "@COM1\nPRINTL OLD\nRETURN 1\n").unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let submitted = project.retained_manifest_with_progress(None).unwrap();
        assert_eq!(submitted.project_revision, 1);

        fs::write(
            selected.join("command.erb"),
            "@COM0\nPRINTL SELECTED\nRETURN 1\n",
        )
        .unwrap();
        fs::write(other.join("command.erb"), "@COM1\nPRINTL OTHER\nRETURN 1\n").unwrap();
        let selected_reload = project
            .reload_scoped_with_progress(
                &ProjectReloadScope::Folder {
                    path: "ERB/selected".into(),
                },
                None,
            )
            .unwrap();

        assert_eq!(selected_reload.changes.len(), 1);
        assert!(selected_reload.changes.iter().any(|change| matches!(
            change,
            FileChange::Upsert { file }
                if file.relative_path == "ERB/selected/command.erb"
                    && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
        )));
        assert_eq!(project.materialize().unwrap().project_revision, 1);
        project.finalize_reload(true);
        let active = project.materialize().unwrap();
        assert_eq!(active.project_revision, 2);
        assert!(active.files.iter().any(|file| {
            file.relative_path == "ERB/selected/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
        }));
        assert!(active.files.iter().any(|file| {
            file.relative_path == "ERB/other/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
        }));

        let remaining_reload = project
            .reload_scoped_with_progress(
                &ProjectReloadScope::Script {
                    path: "ERB/other/command.erb".into(),
                },
                None,
            )
            .unwrap();
        project.finalize_reload(true);
        assert_eq!(remaining_reload.changes.len(), 1);
        assert!(matches!(
            &remaining_reload.changes[0],
            FileChange::Upsert { file } if file.relative_path == "ERB/other/command.erb"
        ));
    }

    #[test]
    fn sparse_scoped_reload_hydrates_the_active_baseline_and_commits_only_on_success() {
        let directory = tempfile::tempdir().unwrap();
        let selected = directory.path().join("ERB/selected");
        let other = directory.path().join("ERB/other");
        fs::create_dir_all(&selected).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(
            selected.join("command.erb"),
            "@COM0\nPRINTL OLD\nRETURN 1\n",
        )
        .unwrap();
        fs::write(other.join("command.erb"), "@COM1\nPRINTL OLD\nRETURN 1\n").unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        project.retained_manifest_with_progress(None).unwrap();
        project.mark_runtime_manifest_sparse();

        fs::write(
            selected.join("command.erb"),
            "@COM0\nPRINTL SELECTED\nRETURN 1\n",
        )
        .unwrap();
        fs::write(other.join("command.erb"), "@COM1\nPRINTL OTHER\nRETURN 1\n").unwrap();
        let request = project
            .reload_scoped_with_progress(
                &ProjectReloadScope::Folder {
                    path: "ERB/selected".into(),
                },
                None,
            )
            .unwrap();

        assert_eq!(request.base_revision, 1);
        assert_eq!(request.target_revision, 2);
        assert_eq!(request.changes.len(), 2);
        assert!(request.changes.iter().any(|change| matches!(
            change,
            FileChange::Upsert { file }
                if file.relative_path == "ERB/selected/command.erb"
                    && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
        )));
        assert!(request.changes.iter().any(|change| matches!(
            change,
            FileChange::Upsert { file }
                if file.relative_path == "ERB/other/command.erb"
                    && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
        )));
        project.finalize_reload(false);
        let rolled_back = project.materialize().unwrap();
        assert_eq!(rolled_back.project_revision, 1);
        assert!(rolled_back.files.iter().any(|file| {
            file.relative_path == "ERB/selected/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
        }));

        project
            .reload_scoped_with_progress(
                &ProjectReloadScope::Folder {
                    path: "ERB/selected".into(),
                },
                None,
            )
            .unwrap();
        project.finalize_reload(true);
        let active = project.materialize().unwrap();
        assert_eq!(active.project_revision, 2);
        assert!(active.files.iter().any(|file| {
            file.relative_path == "ERB/selected/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
        }));
        assert!(active.files.iter().any(|file| {
            file.relative_path == "ERB/other/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
        }));
    }

    #[test]
    fn reload_targets_include_current_and_removed_scripts() {
        let directory = tempfile::tempdir().unwrap();
        let commands = directory.path().join("ERB/commands");
        fs::create_dir_all(&commands).unwrap();
        fs::write(commands.join("hot.erb"), "@COM0\nRETURN 1\n").unwrap();
        let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        fs::remove_file(commands.join("hot.erb")).unwrap();
        fs::write(commands.join("new.erh"), "#DIM TEST\n").unwrap();

        let targets = project.project_reload_targets().unwrap();

        assert_eq!(targets.folders, ["ERB/commands"]);
        assert_eq!(
            targets.scripts,
            ["ERB/commands/hot.erb", "ERB/commands/new.erh"]
        );
    }

    #[test]
    fn configuration_write_checks_digest_and_atomically_replaces_root_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reraconfig.toml");
        fs::write(&path, "[display]\r\nfont_size = 12\r\n").unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let digest = blake3::hash("[display]\nfont_size = 12\n".as_bytes());

        project
            .write_configuration(digest.as_bytes(), "[display]\nfont_size = 18\n")
            .unwrap();

        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "[display]\nfont_size = 18\n"
        );
        project
            .write_configuration(digest.as_bytes(), "[display]\r\nfont_size = 18\r\n")
            .unwrap();
        assert!(
            project
                .write_configuration(digest.as_bytes(), "[display]\nfont_size = 20\n")
                .unwrap_err()
                .contains("其他程序修改")
        );
    }

    #[test]
    fn configuration_write_refreshes_the_manifest_used_for_full_project_export() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("main.erb"), "@SYSTEM_TITLE\nRETURN\n").unwrap();
        fs::write(
            directory.path().join("reraconfig.toml"),
            "[display]\nfont_size = 12\n",
        )
        .unwrap();
        let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let initial_identity = era_web_bridge::project_identity(project.materialize().unwrap())
            .expect("initial manifest has an identity");
        let digest = blake3::hash("[display]\nfont_size = 12\n".as_bytes());

        project
            .write_configuration(digest.as_bytes(), "[display]\nfont_size = 18\n")
            .unwrap();

        let (refreshed_identity, has_updated_configuration) = {
            let refreshed = project.materialize().unwrap();
            (
                era_web_bridge::project_identity(refreshed)
                    .expect("refreshed manifest has an identity"),
                refreshed.files.iter().any(|file| {
                    matches!(
                        &file.payload,
                        FilePayload::Utf8(contents)
                            if file.relative_path.eq_ignore_ascii_case("reraconfig.toml")
                                && contents == "[display]\nfont_size = 18\n"
                    )
                }),
            )
        };
        assert_ne!(refreshed_identity, initial_identity);
        assert_eq!(refreshed_identity, project.identity());
        assert!(has_updated_configuration);
    }

    #[test]
    fn reraconfig_requires_strict_utf8() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("reraconfig.toml"), [0x81]).unwrap();
        let Err(error) = ProjectHost::scan_quick(directory.path(), 1) else {
            panic!("non-UTF-8 reraconfig.toml must be rejected during the initial scan");
        };
        assert!(error.contains("valid UTF-8"));
    }
}
