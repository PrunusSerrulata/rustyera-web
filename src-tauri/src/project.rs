use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FileChange, FilePayload, ProjectManifest, ReloadProject, SubmittedFile,
    validate_relative_path,
};
use unicode_normalization::UnicodeNormalization;
use walkdir::{DirEntry, WalkDir};

const RESOURCE_SUFFIXES: &[&str] = &[
    "bmp", "gif", "jpeg", "jpg", "png", "webp", "wav", "mp3", "ogg", "opus", "aac", "m4a", "flac",
];

pub struct ProjectHost {
    root: PathBuf,
    manifest: ProjectManifest,
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
            manifest: ProjectManifest {
                project_revision: revision,
                files,
            },
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub const fn manifest(&self) -> &ProjectManifest {
        &self.manifest
    }

    pub fn reload(&mut self) -> Result<ReloadProject, String> {
        let candidate = Self::scan(&self.root, self.manifest.project_revision.saturating_add(1))?;
        let old = by_path(&self.manifest);
        let new = by_path(&candidate.manifest);
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
            base_revision: self.manifest.project_revision,
            target_revision: candidate.manifest.project_revision,
            changes,
        };
        *self = candidate;
        Ok(request)
    }

    pub fn read_resource(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        let relative = validate_relative_path(relative_path).map_err(|error| error.to_string())?;
        let path = self.root.join(relative);
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("cannot open resource: {error}"))?;
        if canonical != self.root && !canonical.starts_with(&self.root) {
            return Err("resource path escapes the project root".into());
        }
        fs::read(canonical).map_err(|error| format!("cannot read resource: {error}"))
    }
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
        let text = String::from_utf8(bytes)
            .map_err(|error| format!("{relative_path} is not valid UTF-8: {error}"))?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
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
}
