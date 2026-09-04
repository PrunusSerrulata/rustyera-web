use era_runtime_protocol::{
    ExternalResource, FileCategory, FilePayload, ImageMetadataResponse, ProjectManifest,
    ProtocolBytes, SubmittedFile,
};

const BROWSER_MANIFEST_MAGIC: &[u8; 8] = b"RERMAN02";

pub(super) fn decode_browser_manifest(bytes: &[u8]) -> Result<ProjectManifest, String> {
    let mut reader = BinaryReader::new(bytes);
    if reader.read_exact(BROWSER_MANIFEST_MAGIC.len())? != BROWSER_MANIFEST_MAGIC {
        return Err("browser project manifest has an invalid header".into());
    }
    let project_revision = reader.read_u64()?;
    let file_count = usize::try_from(reader.read_u32()?)
        .map_err(|_| "browser project manifest file count is too large")?;
    let compatibility_length = usize::try_from(reader.read_u32()?)
        .map_err(|_| "browser compatibility identity is too large")?;
    let compatibility = serde_json::from_slice(reader.read_exact(compatibility_length)?)
        .map_err(|error| format!("browser compatibility identity is invalid: {error}"))?;
    if file_count > bytes.len() / 15 {
        return Err("browser project manifest file count exceeds its encoded size".into());
    }
    let mut files = Vec::new();
    files
        .try_reserve_exact(file_count)
        .map_err(|_| "browser project manifest allocation failed")?;
    for _ in 0..file_count {
        let category = decode_file_category(reader.read_u8()?)?;
        let path_length =
            usize::try_from(reader.read_u32()?).map_err(|_| "browser project path is too large")?;
        let payload_tag = reader.read_u8()?;
        let payload_length = usize::try_from(reader.read_u64()?)
            .map_err(|_| "browser project payload is too large")?;
        let hash_length = usize::from(reader.read_u8()?);
        if !matches!(hash_length, 0 | 32) {
            return Err("browser project content hash must be empty or 32 bytes".into());
        }
        let relative_path = String::from_utf8(reader.read_exact(path_length)?.to_vec())
            .map_err(|_| "browser project path is not UTF-8")?;
        let payload_bytes = reader.read_exact(payload_length)?;
        let payload = match payload_tag {
            0 => FilePayload::Utf8(
                String::from_utf8(payload_bytes.to_vec())
                    .map_err(|_| "browser project text payload is not UTF-8")?,
            ),
            1 => FilePayload::Bytes(ProtocolBytes::new(payload_bytes.to_vec())),
            2 => decode_external_resource(payload_bytes)?,
            _ => return Err("browser project payload tag is invalid".into()),
        };
        let content_hash = (hash_length != 0)
            .then(|| {
                reader
                    .read_exact(hash_length)
                    .map(|hash| ProtocolBytes::new(hash.to_vec()))
            })
            .transpose()?;
        files.push(SubmittedFile {
            relative_path,
            category,
            payload,
            content_hash,
        });
    }
    if !reader.is_empty() {
        return Err("browser project manifest has trailing bytes".into());
    }
    Ok(ProjectManifest {
        project_revision,
        files,
        compatibility,
    })
}

pub(super) fn decode_external_resource(bytes: &[u8]) -> Result<FilePayload, String> {
    if bytes.len() != 18 {
        return Err("browser external resource descriptor has an invalid size".into());
    }
    let byte_length = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let image_metadata = if bytes[16] == 0xff {
        None
    } else {
        let format = match bytes[16] {
            0 => "png",
            1 => "bmp",
            2 => "gif",
            3 => "jpeg",
            4 => "webp",
            _ => return Err("browser external resource image format is invalid".into()),
        };
        let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        if width == 0 || height == 0 || bytes[17] > 1 {
            return Err("browser external resource image metadata is invalid".into());
        }
        Some(ImageMetadataResponse {
            width,
            height,
            format: format.to_owned(),
            animated: bytes[17] != 0,
        })
    };
    Ok(FilePayload::ExternalResource(ExternalResource {
        byte_length,
        image_metadata,
    }))
}

pub(super) fn decode_file_category(value: u8) -> Result<FileCategory, String> {
    match value {
        0 => Ok(FileCategory::Csv),
        1 => Ok(FileCategory::Erh),
        2 => Ok(FileCategory::Erb),
        3 => Ok(FileCategory::ResourceManifest),
        4 => Ok(FileCategory::Resource),
        5 => Ok(FileCategory::Configuration),
        6 => Ok(FileCategory::Als),
        7 => Ok(FileCategory::Erd),
        _ => Err("browser project file category is invalid".into()),
    }
}

struct BinaryReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BinaryReader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_exact(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or("browser project manifest length overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("browser project manifest is truncated")?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        self.read_exact(1).map(|bytes| bytes[0])
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        self.read_exact(4).map(|bytes| {
            u32::from_le_bytes(bytes.try_into().expect("four-byte slice was requested"))
        })
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        self.read_exact(8).map(|bytes| {
            u64::from_le_bytes(bytes.try_into().expect("eight-byte slice was requested"))
        })
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::decode_browser_manifest;
    use crate::{
        ProjectFileResources, ProjectFileUpload, ProjectManifestUpload, take_project_file_resources,
    };
    use era_runtime_protocol::{
        ExternalResource, FileCategory, FilePayload, ProjectManifest, ProtocolBytes, SubmittedFile,
    };

    #[test]
    fn browser_manifest_binary_decodes_text_and_resource_payloads() {
        let mut bytes = b"RERMAN02".to_vec();
        bytes.extend_from_slice(&7_u64.to_le_bytes());
        bytes.extend_from_slice(&3_u32.to_le_bytes());
        let compatibility =
            serde_json::to_vec(&era_runtime_protocol::CompatibilityIdentity::default()).unwrap();
        bytes.extend_from_slice(&u32::try_from(compatibility.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&compatibility);
        append_file(&mut bytes, 2, b"main.erb", 0, b"@MAIN\nRETURN\n", &[3; 32]);
        append_file(&mut bytes, 4, b"resources/a.png", 1, &[1, 2, 3], &[4; 32]);
        let mut external = Vec::new();
        external.extend_from_slice(&1234_u64.to_le_bytes());
        external.extend_from_slice(&640_u32.to_le_bytes());
        external.extend_from_slice(&480_u32.to_le_bytes());
        external.extend_from_slice(&[0, 0]);
        append_file(&mut bytes, 4, b"resources/b.png", 2, &external, &[5; 32]);

        let manifest = decode_browser_manifest(&bytes).unwrap();

        assert_eq!(manifest.project_revision, 7);
        assert_eq!(manifest.files[0].category, FileCategory::Erb);
        assert!(
            matches!(&manifest.files[0].payload, FilePayload::Utf8(text) if text.contains("MAIN"))
        );
        assert!(
            matches!(&manifest.files[1].payload, FilePayload::Bytes(value) if value.as_slice() == [1, 2, 3])
        );
        assert_eq!(
            manifest.files[1].content_hash.as_ref().unwrap().as_slice(),
            [4; 32]
        );
        assert!(matches!(
            &manifest.files[2].payload,
            FilePayload::ExternalResource(resource)
                if resource.byte_length == 1234
                    && resource.image_metadata.as_ref().is_some_and(|value| value.width == 640)
        ));
    }

    #[test]
    fn index_data_categories_survive_binary_and_streamed_manifests() {
        let identity = era_runtime_protocol::CompatibilityIdentity::default();
        let encoded_identity = serde_json::to_vec(&identity).unwrap();
        let mut bytes = b"RERMAN02".to_vec();
        bytes.extend_from_slice(&1_u64.to_le_bytes());
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(encoded_identity.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&encoded_identity);
        append_file(&mut bytes, 6, b"ERB/BUFF.als", 0, b"10,alias\n", &[6; 32]);
        append_file(&mut bytes, 7, b"ERB/BUFF.erd", 0, b"10,main\n", &[7; 32]);
        let manifest = decode_browser_manifest(&bytes).unwrap();
        assert_eq!(manifest.files[0].category, FileCategory::Als);
        assert_eq!(manifest.files[1].category, FileCategory::Erd);
        let mut upload = ProjectManifestUpload::default();
        upload.begin(1, 2, identity, 1024).unwrap();
        for file in &manifest.files {
            upload.append(file.clone()).unwrap();
        }
        assert_eq!(upload.finish().unwrap(), manifest);
    }

    #[test]
    fn browser_manifest_identity_survives_binary_and_chunk_transfers() {
        let identity = era_runtime_protocol::CompatibilityIdentity::for_profile(
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        let mut bytes = b"RERMAN02".to_vec();
        bytes.extend_from_slice(&9_u64.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        let encoded = serde_json::to_vec(&identity).unwrap();
        bytes.extend_from_slice(&u32::try_from(encoded.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&encoded);
        assert_eq!(
            decode_browser_manifest(&bytes).unwrap().compatibility,
            identity
        );
        let mut upload = ProjectManifestUpload::default();
        upload.begin(9, 0, identity.clone(), 1024).unwrap();
        assert_eq!(upload.finish().unwrap().compatibility, identity);
        bytes.truncate(bytes.len() - 1);
        assert!(decode_browser_manifest(&bytes).is_err());
        assert!(decode_browser_manifest(b"RERMAN01").is_err());
    }

    #[test]
    fn streamed_browser_manifest_retains_only_final_file_payloads() {
        let mut upload = ProjectManifestUpload::default();
        upload
            .begin(
                7,
                2,
                era_runtime_protocol::CompatibilityIdentity::default(),
                1024,
            )
            .unwrap();
        let source = String::from("@MAIN\nRETURN\n");
        let source_allocation = source.as_ptr();
        upload
            .append(SubmittedFile {
                relative_path: "main.erb".into(),
                category: FileCategory::Erb,
                payload: FilePayload::Utf8(source),
                content_hash: Some(ProtocolBytes::new(vec![3; 32])),
            })
            .unwrap();
        upload
            .append(SubmittedFile {
                relative_path: "resources/a.png".into(),
                category: FileCategory::Resource,
                payload: FilePayload::ExternalResource(ExternalResource {
                    byte_length: 1234,
                    image_metadata: None,
                }),
                content_hash: Some(ProtocolBytes::new(vec![4; 32])),
            })
            .unwrap();

        let manifest = upload.finish().unwrap();

        assert_eq!(manifest.project_revision, 7);
        assert!(matches!(
            &manifest.files[0].payload,
            FilePayload::Utf8(source) if source.as_ptr() == source_allocation
        ));
        assert!(upload.finish().unwrap_err().contains("no browser project"));
    }

    #[test]
    fn streamed_browser_manifest_upload_is_transactional_and_reusable() {
        let file = || SubmittedFile {
            relative_path: "main.erb".into(),
            category: FileCategory::Erb,
            payload: FilePayload::Utf8("@MAIN\nRETURN\n".into()),
            content_hash: None,
        };
        let mut upload = ProjectManifestUpload::default();

        upload
            .begin(
                7,
                2,
                era_runtime_protocol::CompatibilityIdentity::default(),
                1024,
            )
            .unwrap();
        assert!(
            upload
                .begin(
                    8,
                    1,
                    era_runtime_protocol::CompatibilityIdentity::default(),
                    1024
                )
                .unwrap_err()
                .contains("already active")
        );
        upload.append(file()).unwrap();
        assert!(upload.finish().unwrap_err().contains("received 1 of 2"));
        upload.append(file()).unwrap();
        assert!(upload.append(file()).unwrap_err().contains("more files"));
        assert_eq!(upload.finish().unwrap().files.len(), 2);

        upload
            .begin(
                9,
                1,
                era_runtime_protocol::CompatibilityIdentity::default(),
                1024,
            )
            .unwrap();
        upload.append(file()).unwrap();
        upload.cancel();
        upload
            .begin(
                10,
                1,
                era_runtime_protocol::CompatibilityIdentity::default(),
                1024,
            )
            .unwrap();
        upload.append(file()).unwrap();
        assert_eq!(upload.finish().unwrap().project_revision, 10);
    }

    #[test]
    fn streamed_browser_manifest_preflights_header_and_file_size_before_append() {
        let mut upload = ProjectManifestUpload::default();
        let minimum_manifest_bytes = ProjectManifestUpload::HEADER_BYTES
            + serde_json::to_vec(&era_runtime_protocol::CompatibilityIdentity::default())
                .unwrap()
                .len()
            + ProjectManifestUpload::FILE_FIXED_BYTES;
        assert!(
            upload
                .begin(
                    1,
                    0,
                    era_runtime_protocol::CompatibilityIdentity::default(),
                    19
                )
                .unwrap_err()
                .contains("file count")
        );
        upload
            .begin(
                1,
                1,
                era_runtime_protocol::CompatibilityIdentity::default(),
                minimum_manifest_bytes,
            )
            .unwrap();
        assert!(
            upload
                .preflight("main.erb".len(), 1, 0)
                .unwrap_err()
                .contains("transfer limit")
        );
        assert!(
            upload
                .pending
                .as_ref()
                .expect("active upload")
                .manifest
                .files
                .is_empty()
        );
    }

    #[test]
    fn project_file_upload_enforces_bounds_completion_and_reuse() {
        let mut upload = ProjectFileUpload::default();
        assert!(upload.finish().unwrap_err().contains("no project file"));

        upload.begin(3, 3).unwrap();
        assert!(upload.begin(3, 3).unwrap_err().contains("already active"));
        upload
            .append_destination(2)
            .unwrap()
            .copy_from_slice(&[1, 2]);
        assert!(
            upload
                .append_destination(2)
                .unwrap_err()
                .contains("declared size")
        );
        assert!(upload.finish().unwrap_err().contains("received 2 of 3"));
        upload.append_destination(1).unwrap().copy_from_slice(&[3]);
        assert_eq!(upload.finish().unwrap(), [1, 2, 3]);

        upload.begin(2, 3).unwrap();
        upload.append_destination(1).unwrap()[0] = 9;
        upload.cancel();
        upload.begin(1, 3).unwrap();
        upload.append_destination(1).unwrap()[0] = 4;
        assert_eq!(upload.finish().unwrap(), [4]);
    }

    #[test]
    fn project_file_upload_rejects_a_declared_size_above_the_limit() {
        let mut upload = ProjectFileUpload::default();

        assert!(upload.begin(4, 3).unwrap_err().contains("transfer limit"));
        upload.begin(3, 3).unwrap();
    }

    #[test]
    fn cancelled_project_file_upload_can_restart() {
        let mut upload = ProjectFileUpload::default();
        upload.begin(2, 265).unwrap();
        upload.append_destination(1).unwrap()[0] = 7;
        upload.cancel();
        upload.begin(1, 265).unwrap();
        upload.append_destination(1).unwrap()[0] = 9;
        assert_eq!(upload.finish().unwrap(), [9]);
    }

    #[test]
    fn packaged_resources_move_out_of_the_frontend_manifest() {
        let mut manifest = ProjectManifest {
            compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
            project_revision: 1,
            files: vec![SubmittedFile {
                relative_path: "Resources/Title.bin".into(),
                category: FileCategory::Resource,
                payload: FilePayload::Bytes(ProtocolBytes::new(vec![1, 2, 3])),
                content_hash: Some(ProtocolBytes::new(vec![4; 32])),
            }],
        };

        let resources = take_project_file_resources(&mut manifest);

        assert_eq!(resources["resources/title.bin"], [1, 2, 3]);
        assert!(matches!(
            &manifest.files[0].payload,
            FilePayload::ExternalResource(resource)
                if resource.byte_length == 3 && resource.image_metadata.is_none()
        ));
    }

    #[test]
    fn project_resource_replacement_commits_only_after_a_successful_load() {
        let mut resources = ProjectFileResources {
            active: std::collections::BTreeMap::from([("resources/a.bin".into(), vec![1, 2, 3])]),
            ..ProjectFileResources::default()
        };

        resources.stage_packaged(
            6,
            std::collections::BTreeMap::from([("resources/b.bin".into(), vec![4, 5, 6])]),
        );
        assert_eq!(resources.get("resources/b.bin"), Some([4, 5, 6].as_slice()));
        assert!(resources.get("resources/a.bin").is_none());
        assert!(resources.get("resources/missing.bin").is_none());
        resources.complete_replacement(6, false);
        assert_eq!(resources.get("resources/a.bin"), Some([1, 2, 3].as_slice()));

        resources.stage_packaged(
            7,
            std::collections::BTreeMap::from([("resources/b.bin".into(), vec![4, 5, 6])]),
        );
        resources.complete_replacement(7, true);
        assert!(resources.get("resources/a.bin").is_none());
        assert_eq!(resources.get("resources/b.bin"), Some([4, 5, 6].as_slice()));

        resources.track_replacement(8);
        resources.complete_replacement(8, false);
        assert_eq!(resources.get("resources/b.bin"), Some([4, 5, 6].as_slice()));

        resources.track_replacement(9);
        resources.complete_replacement(9, true);
        assert!(resources.get("resources/b.bin").is_none());
    }

    fn append_file(
        output: &mut Vec<u8>,
        category: u8,
        path: &[u8],
        payload_tag: u8,
        payload: &[u8],
        hash: &[u8],
    ) {
        output.push(category);
        output.extend_from_slice(&u32::try_from(path.len()).unwrap().to_le_bytes());
        output.push(payload_tag);
        output.extend_from_slice(&u64::try_from(payload.len()).unwrap().to_le_bytes());
        output.push(u8::try_from(hash.len()).unwrap());
        output.extend_from_slice(path);
        output.extend_from_slice(payload);
        output.extend_from_slice(hash);
    }
}
