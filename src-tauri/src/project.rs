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
    CompatibilityIdentity, CompatibilityProfileId, ExternalResource, FileCategory, FileChange,
    FilePayload, ImageMetadataResponse, ProjectIdentity, ProjectManifest, ReloadProject,
    SubmittedFile, validate_relative_path,
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
const PACKAGED_PROJECT_READ_CHUNK_BYTES: usize = 1024 * 1024;
const MAXIMUM_PROJECT_FONT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
struct IndexedFile {
    relative_path: String,
    source_path: Option<PathBuf>,
    category: FileCategory,
    content_hash: [u8; 32],
    byte_length: u64,
    pending_file: Option<SubmittedFile>,
    source_signature: Option<[u64; 5]>,
    index_reused: bool,
}

struct PendingProjectReload {
    indexed_files: Vec<IndexedFile>,
    revision: u64,
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
        StoredSourceIndexCategory::Code(code) if code <= FileCategory::Erd as u8 => Ok(code),
        StoredSourceIndexCategory::Name(name) => match name.as_str() {
            "csv" => Ok(FileCategory::Csv as u8),
            "erh" => Ok(FileCategory::Erh as u8),
            "erb" => Ok(FileCategory::Erb as u8),
            "resource_manifest" => Ok(FileCategory::ResourceManifest as u8),
            "resource" => Ok(FileCategory::Resource as u8),
            "configuration" => Ok(FileCategory::Configuration as u8),
            "als" => Ok(FileCategory::Als as u8),
            "erd" => Ok(FileCategory::Erd as u8),
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
    compatibility: CompatibilityIdentity,
    manifest: Option<ProjectManifest>,
    indexed_files: Vec<IndexedFile>,
    revision: u64,
    embedded_resources: BTreeMap<String, Vec<u8>>,
    packaged_project: Option<PackagedProjectFile>,
    runtime_manifest_sparse: bool,
    pending_reload: Option<PendingProjectReload>,
    source_index_stats: (usize, usize),
}

struct PackagedProjectFile {
    path: PathBuf,
    storage_key: String,
    file_digest: [u8; 32],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFontSource {
    pub relative_path: String,
    pub content_hash: Vec<u8>,
    pub byte_length: u64,
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
        if !matches!(
            category,
            FileCategory::Erb | FileCategory::Erh | FileCategory::Als | FileCategory::Erd
        ) {
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
        let root = self.packaged_project.as_ref().map_or_else(
            || self.root.clone(),
            |project| {
                self.root
                    .join(".rustyera/packaged-projects")
                    .join(&project.storage_key)
            },
        );
        if self.compatibility.profile == CompatibilityProfileId::EmueraSkiaSnake {
            root.join(".rustyera/profiles/emuera.skia.snake")
        } else {
            root
        }
    }

    pub(super) fn compiled_cache_path(&self) -> PathBuf {
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

    fn read_packaged_resource(
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

fn decode_packaged_project(
    path: &Path,
    progress: Option<&dyn Fn(usize, usize)>,
) -> Result<era_runtime::DecodedProjectFileStream, String> {
    let length = fs::metadata(path)
        .map_err(|error| format!("cannot stat project file: {error}"))?
        .len();
    let length = usize::try_from(length).map_err(|_| "project file is too large".to_owned())?;
    let mut decoder = era_runtime::ProjectFileStreamDecoder::new(length, length)
        .map_err(|error| error.to_string())?;
    let mut file =
        fs::File::open(path).map_err(|error| format!("cannot open project file: {error}"))?;
    let mut buffer = vec![0_u8; PACKAGED_PROJECT_READ_CHUNK_BYTES];
    let mut completed = 0_usize;
    if let Some(report) = progress {
        report(0, length);
    }
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read project file: {error}"))?;
        if read == 0 {
            break;
        }
        decoder
            .append(&buffer[..read])
            .map_err(|error| error.to_string())?;
        completed += read;
        if let Some(report) = progress {
            report(completed, length);
        }
    }
    decoder.finish().map_err(|error| error.to_string())
}

fn packaged_project_storage_key(path: &Path) -> String {
    blake3::hash(path.to_string_lossy().as_bytes())
        .to_hex()
        .to_string()
}

mod resource_storage;
mod scan;

#[allow(clippy::wildcard_imports)]
use scan::*;

#[cfg(test)]
mod tests;
