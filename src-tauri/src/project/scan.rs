use super::*;

pub(super) fn project_entries(
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

pub(super) struct ProgressGate<'a> {
    callback: Option<&'a dyn Fn(usize, usize)>,
    last: Option<(usize, usize)>,
    pub(super) last_emitted: Instant,
}

impl<'a> ProgressGate<'a> {
    pub(super) fn new(callback: Option<&'a dyn Fn(usize, usize)>) -> Self {
        Self {
            callback,
            last: None,
            last_emitted: Instant::now(),
        }
    }

    pub(super) fn report(&mut self, completed: usize, total: usize) {
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

pub(super) fn parallel_ordered<T: Send>(
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

pub(super) fn indexed_file(file: &SubmittedFile) -> Result<IndexedFile, String> {
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
        byte_length: match &file.payload {
            FilePayload::Utf8(text) => text.len() as u64,
            FilePayload::Bytes(bytes) => bytes.as_slice().len() as u64,
            FilePayload::ExternalResource(resource) => resource.byte_length,
            FilePayload::IoError(_) => 0,
        },
        pending_file: None,
        source_signature: None,
        index_reused: false,
    })
}

pub(super) fn canonical_source_roots(root: &Path) -> Result<BTreeSet<String>, String> {
    Ok(fs::read_dir(root)
        .map_err(|error| format!("cannot enumerate project directory: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .filter(|name| name == "csv" || name == "erb")
        .collect())
}

pub(super) fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| "project path escaped its root".to_owned())?
        .to_string_lossy()
        .replace('\\', "/")
        .nfc()
        .collect())
}

pub(super) fn normalized_file_bytes(
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

pub(super) fn normalize_resource_manifest(text: &str) -> String {
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

pub(super) fn normalize_resource_manifest_line(line: &str) -> String {
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

pub(super) fn normalized_project_text(
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

pub(super) fn decode_project_text(bytes: &[u8]) -> Option<String> {
    for encoding in [UTF_8, SHIFT_JIS, GBK] {
        if let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(bytes) {
            return Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned());
        }
    }
    None
}

pub(super) fn metadata_signature(metadata: &fs::Metadata) -> [u64; 5] {
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

pub(super) fn write_source_index(path: &Path, index: &SourceIndex) -> Result<(), String> {
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

pub(super) fn encode_hash(hash: &[u8; 32]) -> String {
    let mut result = String::with_capacity(64);
    for byte in hash {
        write!(result, "{byte:02x}").expect("writing to a String cannot fail");
    }
    result
}

pub(super) fn decode_hash(value: &str) -> Result<[u8; 32], String> {
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

pub(super) fn by_path(manifest: &ProjectManifest) -> BTreeMap<&str, &SubmittedFile> {
    manifest
        .files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect()
}

pub(super) fn indexed_by_path(files: &[IndexedFile]) -> BTreeMap<&str, &IndexedFile> {
    files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect()
}

pub(super) fn include_entry(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || !entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(".rustyera")
}

pub(super) fn classify(
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

pub(super) fn is_project_font_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let mut parts = normalized.split('/');
    let first = parts.next().unwrap_or_default();
    let extension = Path::new(&normalized)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    first.eq_ignore_ascii_case("font") && FONT_SUFFIXES.contains(&extension.as_str())
}

pub(super) fn normalize_configuration_text(text: &str) -> String {
    text.trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

pub(super) fn native_configuration_contents(contents: &str) -> String {
    let normalized = contents.replace("\r\n", "\n").replace('\r', "\n");
    #[cfg(windows)]
    {
        return normalized.replace('\n', "\r\n");
    }
    #[cfg(not(windows))]
    normalized
}

pub(super) fn read_file(
    root: &Path,
    path: &Path,
    category: FileCategory,
) -> Result<SubmittedFile, String> {
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
        let image_metadata = crate::image_metadata::decode(&bytes[..bytes.len().min(1024 * 1024)])
            .map(|metadata| ImageMetadataResponse {
                width: metadata.width,
                height: metadata.height,
                format: metadata.format.to_owned(),
                animated: metadata.animated,
            });
        (
            FilePayload::ExternalResource(ExternalResource {
                byte_length: bytes.len() as u64,
                image_metadata,
            }),
            content_hash,
        )
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

pub(super) fn materialize_indexed_file(
    root: &Path,
    indexed: &IndexedFile,
) -> Result<SubmittedFile, String> {
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

pub(super) fn stable_read_file(
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

pub(super) fn stable_read<T>(
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

pub(super) fn retry_stable_scan<T>(
    mut scan: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    for _ in 0..STABLE_SCAN_ATTEMPTS {
        match scan() {
            Err(error) if error == "project changed while it was being scanned" => {}
            result => return result,
        }
    }
    Err("project changed repeatedly while it was being scanned".into())
}

fn reused_source_index_entry(
    previous: &BTreeMap<String, SourceIndexEntry>,
    relative_path: &str,
    category: FileCategory,
    signature: [u64; 5],
) -> Option<([u8; 32], u64, Option<IndexedImageMetadata>)> {
    previous
        .get(relative_path)
        .filter(|prior| {
            prior.signature == portable_source_signature(signature)
                && prior.category == category as u8
        })
        .and_then(|prior| {
            decode_hash(&prior.hash)
                .ok()
                .map(|hash| (hash, prior.size, prior.image_metadata.clone()))
        })
}

pub(super) fn scan_indexed_entry(
    root: &Path,
    path: &Path,
    category: FileCategory,
    previous: &BTreeMap<String, SourceIndexEntry>,
) -> Result<(IndexedFile, SourceIndexEntry), String> {
    let relative_path = relative_path(root, path)?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("cannot stat {relative_path}: {error}"))?;
    let signature = metadata_signature(&metadata);
    let prior = reused_source_index_entry(previous, &relative_path, category, signature);
    let (content_hash, size, pending_file, signature, index_reused) =
        if let Some((hash, size, metadata)) = prior {
            let mut image_metadata = metadata.and_then(IndexedImageMetadata::into_protocol);
            let image_path = path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| IMAGE_SUFFIXES.contains(&value.to_ascii_lowercase().as_str()));
            if category == FileCategory::Resource && image_path && image_metadata.is_none() {
                let mut prefix = Vec::new();
                fs::File::open(path)
                    .map_err(|error| format!("cannot open {relative_path}: {error}"))?
                    .take(1024 * 1024)
                    .read_to_end(&mut prefix)
                    .map_err(|error| format!("cannot read {relative_path}: {error}"))?;
                if fs::metadata(path)
                    .map_err(|error| format!("cannot stat {relative_path}: {error}"))
                    .map(|current| metadata_signature(&current))?
                    != signature
                {
                    return Err("project changed while it was being scanned".into());
                }
                image_metadata =
                    crate::image_metadata::decode(&prefix).map(|metadata| ImageMetadataResponse {
                        width: metadata.width,
                        height: metadata.height,
                        format: metadata.format.to_owned(),
                        animated: metadata.animated,
                    });
            }
            let pending_file = (category == FileCategory::Resource).then(|| SubmittedFile {
                relative_path: relative_path.clone(),
                category,
                payload: FilePayload::ExternalResource(ExternalResource {
                    byte_length: size,
                    image_metadata,
                }),
                content_hash: Some(ProtocolBytes::new(hash.to_vec())),
            });
            (hash, size, pending_file, signature, true)
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
                FilePayload::ExternalResource(resource) => usize::try_from(resource.byte_length)
                    .map_err(|_| format!("{relative_path} is too large"))?,
                FilePayload::IoError(_) => 0,
            };
            (
                content_hash,
                u64::try_from(size).map_err(|_| format!("{relative_path} is too large"))?,
                Some(file),
                stable_signature,
                false,
            )
        };
    let image_metadata = pending_file.as_ref().and_then(|file| match &file.payload {
        FilePayload::ExternalResource(resource) => resource
            .image_metadata
            .as_ref()
            .map(IndexedImageMetadata::from),
        _ => None,
    });
    Ok((
        IndexedFile {
            relative_path,
            source_path: Some(path.to_owned()),
            category,
            content_hash,
            byte_length: size,
            pending_file,
            source_signature: Some(signature),
            index_reused,
        },
        SourceIndexEntry {
            category: category as u8,
            signature: portable_source_signature(signature),
            hash: encode_hash(&content_hash),
            size,
            image_metadata,
        },
    ))
}
