use era_runtime_protocol::{FileCategory, FilePayload, ProjectIdentity, ProjectManifest};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileIdentitySummary {
    pub project_revision: u64,
    pub files: Vec<ProjectFileIdentityEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileIdentityEntry {
    pub relative_path: String,
    pub category: FileCategory,
    pub content_hash: String,
    pub payload_kind: &'static str,
    pub byte_length: u32,
}

/// Calculate the exact project identity used by the runtime cache contract.
///
/// # Errors
///
/// Returns an error if a submitted file is missing its 32-byte content hash.
pub fn project_identity(manifest: &ProjectManifest) -> Result<ProjectIdentity, String> {
    let mut files = manifest
        .files
        .iter()
        .map(|file| {
            (
                file.relative_path.to_lowercase(),
                file.relative_path.as_str(),
                file,
            )
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(right.1)));
    let mut hasher = blake3::Hasher::new_derive_key("rustyera.project-source-identity.v1");
    for (_, _, file) in files {
        let digest = file
            .content_hash
            .as_ref()
            .ok_or_else(|| format!("project file {} has no content hash", file.relative_path))?;
        if digest.as_slice().len() != 32 {
            return Err(format!(
                "project file {} has an invalid content hash",
                file.relative_path
            ));
        }
        let path = file.relative_path.as_bytes();
        hasher.update(&(path.len() as u64).to_le_bytes());
        hasher.update(path);
        hasher.update(&[file.category as u8]);
        hasher.update(digest.as_slice());
    }
    Ok(ProjectIdentity {
        project_revision: manifest.project_revision,
        source_digest: era_protocol::ProtocolBytes::new(hasher.finalize().as_bytes().to_vec()),
        compatibility: manifest.compatibility.clone(),
        configuration_digest: era_runtime::compatibility_configuration_digest(manifest),
    })
}

/// Inspect actual embedded payloads, not the compact frontend manifest's empty source placeholders.
/// The bounded result contains no source or resource bytes and does not load or mutate a session.
///
/// # Errors
/// Rejects oversized/corrupt exports, external or failed payloads, and mismatched content hashes.
pub fn inspect_project_file_identity(bytes: &[u8]) -> Result<ProjectFileIdentitySummary, String> {
    const LIMIT: usize = 64 * 1024 * 1024;
    if bytes.len() > LIMIT {
        return Err("project identity observation exceeds 64 MiB".into());
    }
    let decoded =
        era_runtime::decode_project_file(bytes, LIMIT).map_err(|error| error.to_string())?;
    let mut files = Vec::with_capacity(decoded.manifest.files.len());
    for file in decoded.manifest.files {
        let (payload, payload_kind) = match &file.payload {
            FilePayload::Utf8(text) => (text.as_bytes(), "utf8"),
            FilePayload::Bytes(bytes) => (bytes.as_slice(), "bytes"),
            _ => {
                return Err(format!(
                    "project identity has no embedded payload: {}",
                    file.relative_path
                ));
            }
        };
        let hash = blake3::hash(payload);
        if file
            .content_hash
            .as_ref()
            .map(era_protocol::ProtocolBytes::as_slice)
            != Some(hash.as_bytes().as_slice())
        {
            return Err(format!(
                "project identity payload hash mismatch: {}",
                file.relative_path
            ));
        }
        files.push(ProjectFileIdentityEntry {
            relative_path: file.relative_path,
            category: file.category,
            content_hash: hash.to_hex().to_string(),
            payload_kind,
            byte_length: u32::try_from(payload.len())
                .map_err(|_| "project payload is too large")?,
        });
    }
    Ok(ProjectFileIdentitySummary {
        project_revision: decoded.manifest.project_revision,
        files,
    })
}
