use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write};
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
    CompatibilityIdentity, ExternalResource, FileCategory, FilePayload, ImageMetadataResponse,
    ProjectManifest, SubmittedFile, validate_relative_path,
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

mod host_runtime;
mod host_scan;
mod resource_storage;
mod scan;

#[allow(clippy::wildcard_imports)]
use scan::*;

#[cfg(test)]
mod tests;
