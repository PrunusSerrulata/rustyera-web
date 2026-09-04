use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use era_runtime_protocol::{FrontendIoError, FrontendIoErrorKind, validate_relative_path};

#[derive(Debug)]
pub(super) struct ResolvedReadPath {
    pub root: PathBuf,
    pub path: PathBuf,
    /// An observation made during lookup, never downgraded by a later existence check.
    pub existed: bool,
}

pub(super) fn validate_read_path(
    root: &Path,
    path: PathBuf,
    existed: bool,
) -> Result<ResolvedReadPath, std::io::Error> {
    if !existed {
        return Ok(ResolvedReadPath {
            root: root.to_owned(),
            path,
            existed,
        });
    }
    let canonical_root = root.canonicalize().map_err(traversal_error)?;
    let relative = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(&canonical_root))
        .map_err(|_| invalid_path())?;
    let logical = canonical_root.join(relative);
    let canonical = logical.canonicalize().map_err(traversal_error)?;
    if canonical != canonical_root && !canonical.starts_with(&canonical_root) {
        return Err(invalid_path());
    }
    // Canonical paths prove containment; logical paths retain an authorized alias prefix.
    Ok(ResolvedReadPath {
        root: canonical_root,
        path: logical,
        existed,
    })
}

/// A dangling or vanished known component is not an absent namespace/target directory.
pub(super) fn exists_checked(root: &Path, path: &Path) -> Result<bool, std::io::Error> {
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return match fs::symlink_metadata(root) {
                Ok(_) => Err(traversal_error(error)),
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(other) => Err(other),
            };
        }
        Err(error) => return Err(error),
    };
    let relative = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(&canonical_root))
        .map_err(|_| invalid_path())?;
    let mut logical = canonical_root.clone();
    let mut directories = std::collections::BTreeSet::from([canonical_root.clone()]);
    for component in relative.components() {
        logical.push(component);
        match fs::symlink_metadata(&logical) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
        let canonical = logical.canonicalize().map_err(traversal_error)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "storage path escapes its namespace",
            ));
        }
        if fs::metadata(&logical).map_err(traversal_error)?.is_dir()
            && !directories.insert(canonical)
        {
            return Err(normalized_path_error(
                "storage path contains a directory link loop",
            ));
        }
    }
    Ok(true)
}

pub(crate) fn traversal_error(error: std::io::Error) -> std::io::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        conflict("storage entry disappeared during traversal or is a dangling link")
    } else {
        error
    }
}

pub(super) fn resolve(root: &Path, relative_path: &str) -> Result<PathBuf, std::io::Error> {
    if relative_path.is_empty() {
        return Ok(root.to_owned());
    }
    let relative = validate_relative_path(relative_path)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    Ok(root.join(relative))
}

pub(super) fn ensure_inside(root: &Path, parent: &Path) -> Result<(), std::io::Error> {
    let project = root.canonicalize().or_else(|_| {
        fs::create_dir_all(root)?;
        root.canonicalize()
    })?;
    let parent = parent.canonicalize()?;
    if parent == project || parent.starts_with(project) {
        Ok(())
    } else {
        Err(invalid_path())
    }
}

pub(super) fn revision(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

pub(crate) fn change_token(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    format!("{}:{modified}", metadata.len())
}

pub(super) fn frontend_error(error: &std::io::Error) -> FrontendIoError {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => FrontendIoErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied => FrontendIoErrorKind::PermissionDenied,
        std::io::ErrorKind::InvalidData | std::io::ErrorKind::InvalidInput => {
            FrontendIoErrorKind::InvalidData
        }
        std::io::ErrorKind::Interrupted => FrontendIoErrorKind::Interrupted,
        std::io::ErrorKind::AlreadyExists => FrontendIoErrorKind::Conflict,
        _ => FrontendIoErrorKind::Other,
    };
    FrontendIoError {
        kind,
        message: error.to_string(),
        platform_code: error.raw_os_error().map(i64::from),
    }
}

pub(super) fn conflict(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::AlreadyExists, message)
}

pub(super) fn invalid_path() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "storage path escapes its namespace",
    )
}

/// Resolve each Data component by Resource's NFC + Unicode lowercase identity.
/// Scan the complete existing parent before permitting any filesystem mutation.
pub(super) fn resolve_normalized(root: &Path, relative: &str) -> Result<PathBuf, std::io::Error> {
    resolve_normalized_with_presence(root, relative).map(|(path, _)| path)
}

pub(super) fn resolve_normalized_with_presence(
    root: &Path,
    relative: &str,
) -> Result<(PathBuf, bool), std::io::Error> {
    use std::collections::BTreeSet;
    use unicode_normalization::UnicodeNormalization;

    if relative.contains('\0') {
        return Err(normalized_path_error("storage path contains NUL"));
    }
    let relative = if relative.is_empty() {
        String::new()
    } else {
        validate_relative_path(relative)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?
            .nfc()
            .collect::<String>()
    };
    let parts: Vec<&str> = relative
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if relative.len() > super::MAXIMUM_RELATIVE_PATH_BYTES || parts.len() > 256 {
        return Err(super::budget_exceeded("storage path"));
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Data namespace root cannot be a symbolic link",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((root.join(relative), false));
        }
        Err(error) => return Err(error),
    }
    let root = root.canonicalize().map_err(traversal_error)?;
    let mut current = root.clone();
    let mut directories = BTreeSet::new();
    let mut visited = 0_usize;
    let mut retained_bytes = 0_usize;
    for (index, part) in parts.iter().enumerate() {
        let current_canonical = current.canonicalize().map_err(traversal_error)?;
        if !directories.insert(current_canonical) {
            return Err(normalized_path_error(
                "storage path contains a directory link loop",
            ));
        }
        let mut names = BTreeSet::new();
        let mut selected = None;
        for entry in fs::read_dir(&current).map_err(traversal_error)? {
            let entry = entry.map_err(traversal_error)?;
            visited = visited.saturating_add(1);
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| normalized_path_error("storage directory name is not Unicode"))?;
            let key = insert_normalized_name(&mut names, name)?;
            let candidate = entry.path();
            let candidate_relative = candidate.strip_prefix(&root).map_err(|_| invalid_path())?;
            let candidate_name = candidate_relative
                .to_str()
                .ok_or_else(|| normalized_path_error("storage path is not Unicode"))?;
            retained_bytes = retained_bytes.saturating_add(candidate_name.len());
            if visited > 100_000
                || retained_bytes > 8 * 1024 * 1024
                || candidate_name.len() > super::MAXIMUM_RELATIVE_PATH_BYTES
            {
                return Err(super::budget_exceeded("storage path lookup"));
            }
            if key == part.to_lowercase() {
                selected = Some(candidate);
            }
        }
        let Some(selected) = selected else {
            for remainder in &parts[index..] {
                current.push(remainder);
            }
            return checked_normalized_path(&root, current).map(|path| (path, false));
        };
        let canonical = selected.canonicalize().map_err(traversal_error)?;
        if canonical != root && !canonical.starts_with(&root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "storage path escapes its namespace",
            ));
        }
        let metadata = fs::metadata(&canonical).map_err(traversal_error)?;
        if metadata.is_dir() && directories.contains(&canonical) {
            return Err(normalized_path_error(
                "storage path contains a directory link loop",
            ));
        }
        current = selected;
        if index + 1 < parts.len() && !metadata.is_dir() {
            return Err(normalized_path_error(
                "storage path component is not a directory",
            ));
        }
    }
    checked_normalized_path(&root, current).map(|path| (path, true))
}

fn checked_normalized_path(root: &Path, path: PathBuf) -> Result<PathBuf, std::io::Error> {
    let relative = path.strip_prefix(root).map_err(|_| invalid_path())?;
    if relative.as_os_str().len() > super::MAXIMUM_RELATIVE_PATH_BYTES
        || relative.components().count() > 256
    {
        return Err(super::budget_exceeded("resolved storage path"));
    }
    Ok(path)
}

pub(super) fn validate_storage_basename(name: &str) -> Result<String, std::io::Error> {
    use unicode_normalization::UnicodeNormalization;
    let canonical = name.nfc().collect::<String>();
    if canonical.is_empty()
        || canonical == "."
        || canonical == ".."
        || canonical.contains(['/', '\\', '\0'])
        || canonical.len() > super::MAXIMUM_RELATIVE_PATH_BYTES
        || validate_relative_path(&canonical).is_err()
    {
        return Err(normalized_path_error(
            "storage directory contains an invalid basename",
        ));
    }
    Ok(canonical)
}

fn insert_normalized_name(
    names: &mut std::collections::BTreeSet<String>,
    name: &str,
) -> Result<String, std::io::Error> {
    let key = validate_storage_basename(name)?.to_lowercase();
    if !names.insert(key.clone()) {
        return Err(normalized_path_error(
            "storage directory contains duplicate normalized names",
        ));
    }
    Ok(key)
}

pub(super) fn protocol_relative_path(
    root: &Path,
    path: &Path,
    normalized: bool,
) -> Result<String, std::io::Error> {
    let relative = path.strip_prefix(root).map_err(|_| invalid_path())?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(invalid_path());
        };
        let name = name
            .to_str()
            .ok_or_else(|| normalized_path_error("storage basename is not Unicode"))?;
        let canonical = validate_storage_basename(name)?;
        parts.push(if normalized {
            canonical
        } else {
            name.to_owned()
        });
    }
    if parts.len() > 256 {
        return Err(super::budget_exceeded("storage directory depth"));
    }
    let result = parts.join("/");
    if result.len() > super::MAXIMUM_RELATIVE_PATH_BYTES {
        return Err(super::budget_exceeded("listed storage path"));
    }
    Ok(result)
}

fn normalized_path_error(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod normalized_tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn normalized_sibling_identity_rejects_case_and_unicode_collisions() {
        for (first, second) in [
            ("seed.txt", "SEED.TXT"),
            ("é.txt", "e\u{301}.txt"),
            ("İ.txt", "i\u{307}.txt"),
        ] {
            let mut names = BTreeSet::new();
            assert!(insert_normalized_name(&mut names, first).is_ok());
            let error = insert_normalized_name(&mut names, second).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert!(error.to_string().contains("duplicate normalized"));
        }
    }

    #[test]
    fn new_data_components_are_nfc_and_existing_components_keep_their_spelling() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("MiXeD")).unwrap();
        let resolved = resolve_normalized(root, "mixed/New/e\u{301}.txt").unwrap();
        assert_eq!(
            resolved.strip_prefix(root.canonicalize().unwrap()).unwrap(),
            Path::new("MiXeD/New/é.txt")
        );
        assert!(!root.join("MiXeD/New").exists());
    }

    #[test]
    fn normalized_selected_target_disappearance_is_not_reclassified_as_absence() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("MiXeD");
        fs::create_dir(&target).unwrap();
        let (path, existed) = resolve_normalized_with_presence(root, "mixed").unwrap();
        assert!(existed);
        fs::remove_dir(&target).unwrap();
        let error = validate_read_path(root, path, existed).unwrap_err();
        assert_eq!(frontend_error(&error).kind, FrontendIoErrorKind::Conflict);
    }

    #[test]
    fn invalid_and_excessive_data_paths_do_not_create_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("missing");
        for relative in [
            "a".repeat(4097),
            vec!["a"; 257].join("/"),
            "bad\0name.txt".into(),
            "../escape.txt".into(),
        ] {
            assert!(resolve_normalized(&root, &relative).is_err());
            assert!(!root.exists());
        }
    }
}
