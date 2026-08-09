use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;

use encoding_rs::{GBK, SHIFT_JIS, UTF_8};
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FileChange, FilePayload, ProjectIdentity, ProjectManifest, ReloadProject,
    SubmittedFile, validate_relative_path,
};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use walkdir::{DirEntry, WalkDir};

const RESOURCE_SUFFIXES: &[&str] = &[
    "bmp", "gif", "jpeg", "jpg", "png", "webp", "wav", "mp3", "ogg", "opus", "aac", "m4a", "flac",
];
const AUDIO_SUFFIXES: &[&str] = &["wav", "mp3", "ogg", "opus", "aac", "m4a", "flac"];
const SOURCE_INDEX_VERSION: u32 = 1;
const COMPILED_CACHE_NAME: &str = "compiled-project.reraproj";

#[derive(Clone)]
struct IndexedFile {
    relative_path: String,
    source_path: Option<PathBuf>,
    category: FileCategory,
    content_hash: [u8; 32],
    pending_file: Option<SubmittedFile>,
    source_signature: Option<[u64; 5]>,
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
    packaged: bool,
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
        let mut files = Vec::with_capacity(entries.len());
        for (index, (path, category)) in entries.iter().enumerate() {
            files.push(read_file(&root, path, *category)?);
            report_scan_progress(progress, index + 1, entries.len());
        }
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
            packaged: false,
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
        let mut indexed_files = Vec::new();
        let mut next_index = BTreeMap::new();
        let entries = project_entries(&root, &canonical_roots)?;
        if let Some(progress) = progress {
            progress(0, entries.len());
        }
        for (index, (path, category)) in entries.iter().enumerate() {
            let relative_path = relative_path(&root, path)?;
            let metadata = fs::metadata(path)
                .map_err(|error| format!("cannot stat {relative_path}: {error}"))?;
            let signature = metadata_signature(&metadata);
            let prior = previous
                .get(&relative_path)
                .filter(|prior| prior.signature == signature && prior.category == *category as u8)
                .and_then(|prior| decode_hash(&prior.hash).ok().map(|hash| (hash, prior.size)));
            let (content_hash, size, pending_file) = if let Some((hash, size)) = prior {
                (hash, size, None)
            } else {
                let file = read_file(&root, path, *category)?;
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
                )
            };
            next_index.insert(
                relative_path.clone(),
                SourceIndexEntry {
                    category: *category as u8,
                    signature,
                    hash: encode_hash(&content_hash),
                    size,
                },
            );
            indexed_files.push(IndexedFile {
                relative_path,
                source_path: Some(path.clone()),
                category: *category,
                content_hash,
                pending_file,
                source_signature: Some(signature),
            });
            report_scan_progress(progress, index + 1, entries.len());
        }
        indexed_files.sort_by(|left, right| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        if stored_index.is_none() || previous != next_index {
            write_source_index(
                &index_path,
                &SourceIndex {
                    version: SOURCE_INDEX_VERSION,
                    files: next_index,
                },
            )?;
        }
        Ok(Self {
            root,
            manifest: None,
            indexed_files,
            revision,
            embedded_resources: BTreeMap::new(),
            packaged: false,
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
            packaged: true,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_configuration(
        &self,
        expected_digest: &[u8],
        contents: &str,
    ) -> Result<(), String> {
        if self.packaged {
            return Err("项目文件中的 reraconfig.toml 为只读".into());
        }
        let relative_path = self
            .indexed_files
            .iter()
            .find(|file| file.relative_path.eq_ignore_ascii_case("reraconfig.toml"))
            .map_or("reraconfig.toml", |file| file.relative_path.as_str());
        let target = self.root.join(relative_path);
        let current_digest = match normalized_file_bytes(&target, FileCategory::Configuration) {
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
        let requested_digest = blake3::hash(
            contents
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .as_bytes(),
        );
        if expected_digest.is_empty() && current_digest == requested_digest.as_bytes() {
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
            .persist(target)
            .map_err(|error| format!("cannot replace configuration file: {}", error.error))?;
        Ok(())
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
        if self.manifest.is_none() {
            if let Some(progress) = progress {
                progress(0, self.indexed_files.len());
            }
            let total = self.indexed_files.len();
            let worker_count = thread::available_parallelism()
                .map_or(1, std::num::NonZero::get)
                .min(8)
                .min(total.max(1));
            let chunk_size = total.max(1).div_ceil(worker_count);
            let root = &self.root;
            let indexed_files = &mut self.indexed_files;
            let files = thread::scope(|scope| -> Result<Vec<SubmittedFile>, String> {
                let (sender, receiver) = mpsc::channel();
                for (chunk_index, chunk) in indexed_files.chunks_mut(chunk_size).enumerate() {
                    let sender = sender.clone();
                    scope.spawn(move || {
                        let base = chunk_index.saturating_mul(chunk_size);
                        for (offset, indexed) in chunk.iter_mut().enumerate() {
                            let result = materialize_indexed_file(root, indexed);
                            if sender.send((base + offset, result)).is_err() {
                                break;
                            }
                        }
                    });
                }
                drop(sender);

                let mut ordered = (0..total).map(|_| None).collect::<Vec<_>>();
                for completed in 1..=total {
                    let (index, file) = receiver
                        .recv()
                        .map_err(|error| format!("project file reader stopped early: {error}"))?;
                    ordered[index] = Some(file?);
                    report_scan_progress(progress, completed, total);
                }
                ordered
                    .into_iter()
                    .map(|file| file.ok_or_else(|| "project file reader omitted an entry".into()))
                    .collect()
            })?;
            let manifest = ProjectManifest {
                project_revision: self.revision,
                files,
            };
            if era_web_bridge::project_identity(&manifest)? != self.identity() {
                return Err("project changed while its source files were being loaded".into());
            }
            self.manifest = Some(manifest);
        }
        self.manifest
            .as_ref()
            .ok_or_else(|| "project manifest was not materialized".to_owned())
    }

    pub fn take_manifest_with_progress(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<ProjectManifest, String> {
        self.materialize_with_progress(progress)?;
        self.manifest
            .take()
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

    pub fn reload_with_progress(
        &mut self,
        progress: Option<&dyn Fn(usize, usize)>,
    ) -> Result<ReloadProject, String> {
        if self.packaged {
            return Err("a packaged project cannot reload source files".into());
        }
        self.materialize_with_progress(progress)?;
        let candidate =
            Self::scan_with_progress(&self.root, self.revision.saturating_add(1), progress)?;
        let old_manifest = self
            .manifest
            .as_ref()
            .ok_or_else(|| "project manifest was not materialized".to_owned())?;
        let new_manifest = candidate
            .manifest
            .as_ref()
            .ok_or_else(|| "candidate manifest was not materialized".to_owned())?;
        let old = by_path(old_manifest);
        let new = by_path(new_manifest);
        let paths = old
            .keys()
            .chain(new.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let changes = paths
            .into_iter()
            .filter_map(|path| match (old.get(path), new.get(path)) {
                (Some(previous), Some(current))
                    if previous.category == current.category
                        && previous.content_hash == current.content_hash =>
                {
                    None
                }
                (_, Some(current)) => Some(FileChange::Upsert {
                    file: (*current).clone(),
                }),
                (Some(previous), None) => Some(FileChange::Remove {
                    category: previous.category,
                    relative_path: previous.relative_path.clone(),
                }),
                (None, None) => None,
            })
            .collect();
        let request = ReloadProject {
            base_revision: self.revision,
            target_revision: candidate.revision,
            changes,
        };
        *self = candidate;
        Ok(request)
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

fn report_scan_progress(progress: Option<&dyn Fn(usize, usize)>, completed: usize, total: usize) {
    let percent = completed.saturating_mul(100).checked_div(total);
    let previous_percent = completed
        .saturating_sub(1)
        .saturating_mul(100)
        .checked_div(total);
    if (total == 0 || completed == total || percent > previous_percent)
        && let Some(progress) = progress
    {
        progress(completed, total);
    }
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

fn normalized_file_bytes(path: &Path, category: FileCategory) -> Result<Vec<u8>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if category == FileCategory::Resource {
        return Ok(bytes);
    }
    decode_text_for_path(path, &bytes)
        .map(String::into_bytes)
        .ok_or_else(|| format!("{} is not valid UTF-8, Windows-31J, or GBK", path.display()))
}

fn decode_text_for_path(path: &Path, bytes: &[u8]) -> Option<String> {
    if path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("reraconfig.toml"))
    {
        return std::str::from_utf8(bytes)
            .ok()
            .map(|text| text.strip_prefix('\u{feff}').unwrap_or(text).to_owned());
    }
    decode_project_text(bytes)
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
        let text = decode_text_for_path(path, &bytes).ok_or_else(|| {
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

fn materialize_indexed_file(
    root: &Path,
    indexed: &mut IndexedFile,
) -> Result<SubmittedFile, String> {
    let path = indexed
        .source_path
        .clone()
        .unwrap_or_else(|| root.join(&indexed.relative_path));
    let signature_matches = indexed.source_signature.is_some_and(|expected| {
        fs::metadata(&path).is_ok_and(|metadata| metadata_signature(&metadata) == expected)
    });
    if signature_matches {
        indexed
            .pending_file
            .take()
            .map_or_else(|| read_file(root, &path, indexed.category), Ok)
    } else {
        read_file(root, &path, indexed.category)
    }
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
            .take_manifest_with_progress(Some(&progress))
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
    fn configuration_write_checks_digest_and_atomically_replaces_root_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reraconfig.toml");
        fs::write(&path, "[display]\r\nfont_size = 12\r\n").unwrap();
        let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let digest = blake3::hash("[display]\nfont_size = 12\n".as_bytes());

        project
            .write_configuration(digest.as_bytes(), "[display]\nfont_size = 18\n")
            .unwrap();

        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "[display]\nfont_size = 18\n"
        );
        project
            .write_configuration(&[], "[display]\r\nfont_size = 18\r\n")
            .unwrap();
        assert!(
            project
                .write_configuration(digest.as_bytes(), "[display]\nfont_size = 20\n")
                .unwrap_err()
                .contains("其他程序修改")
        );
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
