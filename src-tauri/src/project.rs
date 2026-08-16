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
    ExternalResource, FileCategory, FileChange, FilePayload, ImageMetadataResponse,
    ProjectIdentity, ProjectManifest, ReloadProject, SubmittedFile, validate_relative_path,
};

const PROJECT_CONFIGURATION_UPDATE_HEADROOM: usize = 1024 * 1024;
use serde::{Deserialize, Deserializer, Serialize};
use unicode_normalization::UnicodeNormalization;
use walkdir::{DirEntry, WalkDir};

const RESOURCE_SUFFIXES: &[&str] = &[
    "bmp", "gif", "jpeg", "jpg", "png", "webp", "wav", "mp3", "ogg", "opus", "aac", "m4a", "flac",
];
const IMAGE_SUFFIXES: &[&str] = &["bmp", "gif", "jpeg", "jpg", "png", "webp"];
const AUDIO_SUFFIXES: &[&str] = &["wav", "mp3", "ogg", "opus", "aac", "m4a", "flac"];
const FONT_SUFFIXES: &[&str] = &["otf", "ttc", "ttf", "woff", "woff2"];
const SOURCE_INDEX_VERSION: u32 = 3;
// v3 uses the browser-common size/mtime-ms signature and is only trusted when the
// caller's project-file-metadata policy permits stat-based source indexing.
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
    index_reused: bool,
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
    #[serde(deserialize_with = "deserialize_source_index_category")]
    category: u8,
    #[serde(deserialize_with = "deserialize_source_index_signature")]
    signature: String,
    hash: String,
    size: u64,
    #[serde(
        default,
        alias = "imageMetadata",
        skip_serializing_if = "Option::is_none"
    )]
    image_metadata: Option<IndexedImageMetadata>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSourceIndexCategory {
    Code(u8),
    Name(String),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSourceIndexSignature {
    Portable(String),
    Native([u64; 5]),
}

fn deserialize_source_index_category<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let stored = StoredSourceIndexCategory::deserialize(deserializer)?;
    match stored {
        StoredSourceIndexCategory::Code(code) if code <= FileCategory::Configuration as u8 => {
            Ok(code)
        }
        StoredSourceIndexCategory::Name(name) => match name.as_str() {
            "csv" => Ok(FileCategory::Csv as u8),
            "erh" => Ok(FileCategory::Erh as u8),
            "erb" => Ok(FileCategory::Erb as u8),
            "resource_manifest" => Ok(FileCategory::ResourceManifest as u8),
            "resource" => Ok(FileCategory::Resource as u8),
            "configuration" => Ok(FileCategory::Configuration as u8),
            _ => Err(serde::de::Error::custom(
                "unknown project source-index category",
            )),
        },
        StoredSourceIndexCategory::Code(_) => Err(serde::de::Error::custom(
            "invalid project source-index category",
        )),
    }
}

fn deserialize_source_index_signature<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        match StoredSourceIndexSignature::deserialize(deserializer)? {
            StoredSourceIndexSignature::Portable(signature) => signature,
            StoredSourceIndexSignature::Native(signature) => portable_source_signature(signature),
        },
    )
}

fn portable_source_signature(signature: [u64; 5]) -> String {
    format!("{}:{}", signature[0], signature[1] / 1_000_000)
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
struct IndexedImageMetadata {
    width: u32,
    height: u32,
    format: String,
    animated: bool,
}

impl IndexedImageMetadata {
    fn into_protocol(self) -> Option<ImageMetadataResponse> {
        (self.width > 0
            && self.height > 0
            && matches!(
                self.format.as_str(),
                "png" | "bmp" | "gif" | "jpeg" | "webp"
            ))
        .then_some(ImageMetadataResponse {
            width: self.width,
            height: self.height,
            format: self.format,
            animated: self.animated,
        })
    }
}

impl From<&ImageMetadataResponse> for IndexedImageMetadata {
    fn from(value: &ImageMetadataResponse) -> Self {
        Self {
            width: value.width,
            height: value.height,
            format: value.format.clone(),
            animated: value.animated,
        }
    }
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

fn write_counted(output: &mut impl Write, written: &mut u64, bytes: &[u8]) -> Result<(), String> {
    *written = written
        .checked_add(
            u64::try_from(bytes.len())
                .map_err(|_| "full project manifest length overflow".to_owned())?,
        )
        .ok_or_else(|| "full project manifest length overflow".to_owned())?;
    if *written > 1024 * 1024 * 1024 {
        return Err("full project manifest exceeds the 1 GiB transfer limit".into());
    }
    output
        .write_all(bytes)
        .map_err(|error| format!("cannot write full project manifest: {error}"))
}

fn write_cbor_head(
    output: &mut impl Write,
    written: &mut u64,
    major: u8,
    value: u64,
) -> Result<(), String> {
    let mut bytes = [0_u8; 9];
    let length = if value < 24 {
        bytes[0] = major << 5 | u8::try_from(value).expect("value below 24 fits in u8");
        1
    } else if let Ok(value) = u8::try_from(value) {
        bytes[0] = major << 5 | 0x18;
        bytes[1] = value;
        2
    } else if let Ok(value) = u16::try_from(value) {
        bytes[0] = major << 5 | 0x19;
        bytes[1..3].copy_from_slice(&value.to_be_bytes());
        3
    } else if let Ok(value) = u32::try_from(value) {
        bytes[0] = major << 5 | 0x1a;
        bytes[1..5].copy_from_slice(&value.to_be_bytes());
        5
    } else {
        bytes[0] = major << 5 | 0x1b;
        bytes[1..9].copy_from_slice(&value.to_be_bytes());
        9
    };
    write_counted(output, written, &bytes[..length])
}

fn write_cbor_text(output: &mut impl Write, written: &mut u64, value: &str) -> Result<(), String> {
    write_cbor_head(
        output,
        written,
        3,
        u64::try_from(value.len()).map_err(|_| "CBOR text length overflow".to_owned())?,
    )?;
    write_counted(output, written, value.as_bytes())
}

fn write_cbor_bytes(
    output: &mut impl Write,
    written: &mut u64,
    value: &[u8],
) -> Result<(), String> {
    write_cbor_head(
        output,
        written,
        2,
        u64::try_from(value.len()).map_err(|_| "CBOR byte string length overflow".to_owned())?,
    )?;
    write_counted(output, written, value)
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
        let root = root
            .canonicalize()
            .map_err(|error| format!("cannot open project directory: {error}"))?;
        if !root.is_dir() {
            return Err("selected project path is not a directory".into());
        }
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

    pub fn write_full_manifest_with_progress_and_cancel(
        &mut self,
        output: &mut impl Write,
        progress: Option<&dyn Fn(usize, usize)>,
        cancelled: Option<&AtomicBool>,
    ) -> Result<u64, String> {
        let manifest = self
            .materialize_with_progress_and_cancel(progress, cancelled)?
            .clone();
        let mut written = 0_u64;
        write_counted(output, &mut written, &[0xa2, 0x00])?;
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

mod scan;

#[allow(clippy::wildcard_imports)]
use scan::*;

#[cfg(test)]
mod tests;
