use era_runtime_protocol::{FileCategory, FilePayload};
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
