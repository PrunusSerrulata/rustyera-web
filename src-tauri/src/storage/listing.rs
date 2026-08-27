use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;

use era_runtime_protocol::storage_pattern::{
    matches_snake_storage_pattern, validate_snake_storage_pattern,
};
use era_runtime_protocol::{StorageEntry, StorageResult};

use super::path::{ResolvedReadPath, change_token, protocol_relative_path, traversal_error};
use super::{
    MAXIMUM_LIST_ENTRIES, MAXIMUM_LIST_PATH_BYTES, MAXIMUM_RELATIVE_PATH_BYTES, account_list_entry,
    budget_exceeded,
};

/// Select the target before traversal. Every subsequent missing entry is a conflict, not fallback.
pub(super) fn list_storage(
    resolved: &ResolvedReadPath,
    pattern: Option<&str>,
    recursive: bool,
    snake: bool,
) -> io::Result<StorageResult> {
    let root = resolved.root.as_path();
    let path = resolved.path.as_path();
    if snake {
        validate_snake_storage_pattern(pattern).map_err(pattern_error)?;
    } else if pattern.is_some_and(|value| value.len() > MAXIMUM_RELATIVE_PATH_BYTES) {
        return Err(budget_exceeded("storage list pattern"));
    }
    let original_pattern = if snake {
        None
    } else {
        pattern
            .map(glob::Pattern::new)
            .transpose()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?
    };
    if !resolved.existed {
        return Ok(StorageResult::Listed {
            entries: Vec::new(),
        });
    }
    let mut entries = Vec::new();
    let mut retained_path_bytes = 0;
    let mut traversed_path_bytes = 0_usize;
    let mut normalized_paths = BTreeSet::new();
    let mut directories = BTreeSet::from([path.canonicalize().map_err(traversal_error)?]);
    let walker = walkdir::WalkDir::new(path)
        .follow_links(snake)
        .min_depth(1)
        .max_depth(if recursive { usize::MAX } else { 1 });
    for (visited, entry) in walker.into_iter().enumerate() {
        if visited >= MAXIMUM_LIST_ENTRIES {
            return Err(budget_exceeded("storage directory traversal"));
        }
        let entry = entry.map_err(walk_error)?;
        let relative = protocol_relative_path(root, entry.path(), snake)?;
        traversed_path_bytes = traversed_path_bytes.saturating_add(relative.len());
        if traversed_path_bytes > MAXIMUM_LIST_PATH_BYTES {
            return Err(budget_exceeded("storage directory traversal paths"));
        }
        if snake && !normalized_paths.insert(relative.to_lowercase()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "storage listing contains duplicate normalized paths",
            ));
        }
        let canonical = entry.path().canonicalize().map_err(traversal_error)?;
        if canonical != root && !canonical.starts_with(root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "storage listing escaped its namespace",
            ));
        }
        if entry.file_type().is_symlink() && !snake {
            validate_original_directory_link(root, entry.path(), &canonical)?;
            continue;
        }
        if entry.file_type().is_dir() {
            if !directories.insert(canonical) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage listing contains a repeated directory link",
                ));
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "storage basename is not Unicode",
            )
        })?;
        let selected = if snake {
            matches_snake_storage_pattern(pattern, name).map_err(pattern_error)?
        } else {
            original_pattern
                .as_ref()
                .is_none_or(|pattern| pattern.matches_path(Path::new(name)))
        };
        if !selected {
            continue;
        }
        account_list_entry(entries.len(), &mut retained_path_bytes, relative.len())?;
        let metadata = fs::metadata(entry.path()).map_err(traversal_error)?;
        entries.push(StorageEntry {
            relative_path: relative,
            byte_length: metadata.len(),
            revision: None,
            change_token: Some(change_token(&metadata)),
        });
    }
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(StorageResult::Listed { entries })
}

// Original walkdir never enumerated directory-link subtrees. Reject ancestor loops without
// treating a safe sibling alias as a repeated directory that was actually traversed.
fn validate_original_directory_link(root: &Path, path: &Path, canonical: &Path) -> io::Result<()> {
    for ancestor in path.parent().into_iter().flat_map(Path::ancestors) {
        if !ancestor.starts_with(root) {
            break;
        }
        if ancestor.canonicalize().map_err(traversal_error)? == canonical {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "storage listing contains a directory link loop",
            ));
        }
    }
    Ok(())
}

fn pattern_error(error: era_runtime_protocol::storage_pattern::StoragePatternError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn walk_error(error: walkdir::Error) -> io::Error {
    if error.loop_ancestor().is_some() {
        return io::Error::new(io::ErrorKind::InvalidData, error);
    }
    let message = error.to_string();
    traversal_error(
        error
            .into_io_error()
            .unwrap_or_else(|| io::Error::new(io::ErrorKind::InvalidData, message)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_failures_keep_permission_and_change_missing_to_conflict() {
        assert_eq!(
            traversal_error(io::Error::from(io::ErrorKind::PermissionDenied)).kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            traversal_error(io::Error::from(io::ErrorKind::NotFound)).kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            traversal_error(io::Error::from(io::ErrorKind::Interrupted)).kind(),
            io::ErrorKind::Interrupted
        );
    }
}
