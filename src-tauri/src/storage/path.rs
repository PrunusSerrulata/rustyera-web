use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use era_runtime_protocol::{
    FrontendIoError, FrontendIoErrorKind, StoragePrecondition, validate_relative_path,
};

pub(super) fn validate_read_path(
    root: &Path,
    path: PathBuf,
) -> Result<(PathBuf, PathBuf), std::io::Error> {
    if !path.try_exists()? {
        return Ok((root.to_owned(), path));
    }
    let root = root.canonicalize()?;
    let path = path.canonicalize()?;
    if path != root && !path.starts_with(&root) {
        return Err(invalid_path());
    }
    Ok((root, path))
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

pub(super) fn verify_precondition(
    path: &Path,
    precondition: &StoragePrecondition,
) -> Result<(), std::io::Error> {
    let current = match fs::read(path) {
        Ok(bytes) => Some(revision(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let matches = match precondition {
        StoragePrecondition::Any => true,
        StoragePrecondition::Missing => current.is_none(),
        StoragePrecondition::Revision(expected) => current.as_ref() == Some(expected),
    };
    if matches {
        Ok(())
    } else {
        Err(conflict("storage precondition did not hold"))
    }
}

pub(super) fn revision(data: &[u8]) -> String {
    blake3::hash(data).to_hex().to_string()
}

pub(super) fn change_token(metadata: &fs::Metadata) -> String {
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
