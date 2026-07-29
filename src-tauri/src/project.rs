use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
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
const SOURCE_INDEX_VERSION: u32 = 1;
const COMPILED_CACHE_NAME: &str = "compiled-project-v8.bin.zst";

#[derive(Clone)]
struct IndexedFile {
    relative_path: String,
    category: FileCategory,
    content_hash: [u8; 32],
}

#[derive(Default, Deserialize, Serialize)]
struct SourceIndex {
    version: u32,
    files: BTreeMap<String, SourceIndexEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
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
}

impl ProjectHost {
    pub fn scan(root: &Path, revision: u64) -> Result<Self, String> {
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
        let mut files = Vec::new();
        for entry in WalkDir::new(&root)
            .follow_links(true)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(include_entry)
        {
            let entry = entry.map_err(|error| format!("cannot scan project: {error}"))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(category) = classify(&root, entry.path(), &canonical_roots)? else {
                continue;
            };
            files.push(read_file(&root, entry.path(), category)?);
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
        })
    }

    pub fn scan_quick(root: &Path, revision: u64) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("cannot open project directory: {error}"))?;
        if !root.is_dir() {
            return Err("selected project path is not a directory".into());
        }
        let index_path = root.join(".rustyera/cache/source-index-v1.json");
        let previous = fs::read(&index_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SourceIndex>(&bytes).ok())
            .filter(|index| index.version == SOURCE_INDEX_VERSION)
            .map(|index| index.files)
            .unwrap_or_default();
        let canonical_roots = canonical_source_roots(&root)?;
        let mut indexed_files = Vec::new();
        let mut next_index = BTreeMap::new();
        for entry in WalkDir::new(&root)
            .follow_links(true)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(include_entry)
        {
            let entry = entry.map_err(|error| format!("cannot scan project: {error}"))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(category) = classify(&root, entry.path(), &canonical_roots)? else {
                continue;
            };
            let relative_path = relative_path(&root, entry.path())?;
            let metadata = entry
                .metadata()
                .map_err(|error| format!("cannot stat {relative_path}: {error}"))?;
            let signature = metadata_signature(&metadata);
            let prior = previous
                .get(&relative_path)
                .filter(|prior| prior.signature == signature && prior.category == category as u8)
                .and_then(|prior| decode_hash(&prior.hash).ok().map(|hash| (hash, prior.size)));
            let (content_hash, size) = if let Some((hash, size)) = prior {
                (hash, size)
            } else {
                let normalized = normalized_file_bytes(entry.path(), category)?;
                (
                    *blake3::hash(&normalized).as_bytes(),
                    u64::try_from(normalized.len())
                        .map_err(|_| format!("{relative_path} is too large"))?,
                )
            };
            next_index.insert(
                relative_path.clone(),
                SourceIndexEntry {
                    category: category as u8,
                    signature,
                    hash: encode_hash(&content_hash),
                    size,
                },
            );
            indexed_files.push(IndexedFile {
                relative_path,
                category,
                content_hash,
            });
        }
        indexed_files.sort_by(|left, right| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        write_source_index(
            &index_path,
            &SourceIndex {
                version: SOURCE_INDEX_VERSION,
                files: next_index,
            },
        )?;
        Ok(Self {
            root,
            manifest: None,
            indexed_files,
            revision,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
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

    pub fn materialize(&mut self) -> Result<&ProjectManifest, String> {
        if self.manifest.is_none() {
            let materialized = Self::scan(&self.root, self.revision)?;
            if materialized.identity() != self.identity() {
                return Err("project changed while its source files were being loaded".into());
            }
            self.manifest = materialized.manifest;
            self.indexed_files = materialized.indexed_files;
        }
        self.manifest
            .as_ref()
            .ok_or_else(|| "project manifest was not materialized".to_owned())
    }

    pub fn take_manifest(&mut self) -> Result<ProjectManifest, String> {
        self.materialize()?;
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

    pub fn reload(&mut self) -> Result<ReloadProject, String> {
        self.materialize()?;
        let candidate = Self::scan(&self.root, self.revision.saturating_add(1))?;
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
        fs::read(self.resource_path(relative_path)?)
            .map_err(|error| format!("cannot read resource: {error}"))
    }

    pub fn read_resource_prefix(
        &self,
        relative_path: &str,
        maximum_bytes: u32,
    ) -> Result<Vec<u8>, String> {
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
        category: file.category,
        content_hash,
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
    decode_project_text(&bytes)
        .map(String::into_bytes)
        .ok_or_else(|| format!("{} is not valid UTF-8, Windows-31J, or GBK", path.display()))
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
    if first == "resources" {
        return Ok(if extension == "csv" {
            Some(FileCategory::ResourceManifest)
        } else if RESOURCE_SUFFIXES.contains(&extension.as_str()) {
            Some(FileCategory::Resource)
        } else {
            None
        });
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

fn read_file(root: &Path, path: &Path, category: FileCategory) -> Result<SubmittedFile, String> {
    let relative_path = path
        .strip_prefix(root)
        .map_err(|_| "project path escaped its root".to_owned())?
        .to_string_lossy()
        .replace('\\', "/")
        .nfc()
        .collect::<String>();
    let bytes = fs::read(path).map_err(|error| format!("cannot read {relative_path}: {error}"))?;
    let (payload, normalized) = if category == FileCategory::Resource {
        (FilePayload::Bytes(ProtocolBytes::new(bytes.clone())), bytes)
    } else {
        let text = decode_project_text(&bytes)
            .ok_or_else(|| format!("{relative_path} is not valid UTF-8, Windows-31J, or GBK"))?;
        let normalized = text.as_bytes().to_vec();
        (FilePayload::Utf8(text), normalized)
    };
    Ok(SubmittedFile {
        relative_path,
        category,
        payload,
        content_hash: Some(ProtocolBytes::new(
            blake3::hash(&normalized).as_bytes().to_vec(),
        )),
    })
}

#[cfg(test)]
mod tests {
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
}
