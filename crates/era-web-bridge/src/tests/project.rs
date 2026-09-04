use super::*;

#[test]
fn project_identity_matches_the_cross_host_fixed_vector() {
    let make = |path: &str, category: FileCategory, digest: Vec<u8>| SubmittedFile {
        relative_path: path.into(),
        category,
        payload: FilePayload::Utf8(String::from("@TEST\nRETURN")),
        content_hash: Some(ProtocolBytes::new(digest)),
    };
    let left = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 7,
        files: vec![
            make("ERB/a.erb", FileCategory::Erb, vec![1; 32]),
            make("ERB/A.erb", FileCategory::Erh, vec![2; 32]),
            make("CSV/config.csv", FileCategory::Csv, (0_u8..32).collect()),
            make("resources/icon.png", FileCategory::Resource, vec![255; 32]),
        ],
    };
    let right = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 7,
        files: vec![
            make("resources/icon.png", FileCategory::Resource, vec![255; 32]),
            make("CSV/config.csv", FileCategory::Csv, (0_u8..32).collect()),
            make("ERB/A.erb", FileCategory::Erh, vec![2; 32]),
            make("ERB/a.erb", FileCategory::Erb, vec![1; 32]),
        ],
    };
    assert_eq!(
        project_identity(&left).unwrap(),
        project_identity(&right).unwrap()
    );
    assert_eq!(
        project_identity(&left).unwrap().source_digest.as_slice(),
        &[
            0x15, 0xd7, 0x21, 0x99, 0xf2, 0xe3, 0x3c, 0x42, 0x9e, 0x0b, 0xd4, 0x18, 0x5e, 0x34,
            0x41, 0xa2, 0x3c, 0x06, 0x50, 0xc1, 0x42, 0x78, 0xd5, 0x76, 0x0c, 0x51, 0x27, 0xd1,
            0xa7, 0x0e, 0x07, 0xec,
        ]
    );
}

#[test]
fn browser_projection_preserves_core_identity_and_root_configuration() {
    let session = negotiated_web_session();
    let configuration = SubmittedFile {
        relative_path: "reraconfig.toml".into(),
        category: FileCategory::Configuration,
        payload: FilePayload::Utf8(
            "[meta]\nschema_version = 4\n[compatibility]\nprofile = \"emuera.skia.snake\"\n".into(),
        ),
        content_hash: None,
    };
    let resolved = session
        .resolve_project_compatibility(Some(configuration.clone()))
        .unwrap();
    let identity = resolved.identity.unwrap();
    assert!(!resolved.diagnostics.is_empty());
    let manifest = ProjectManifest {
        project_revision: 1,
        files: vec![configuration.clone()],
        compatibility: identity.clone(),
    };
    let (_, projected) = split_browser_project_manifest(manifest).unwrap();
    assert_eq!(projected.compatibility, identity);
    assert_eq!(projected.files[0].payload, configuration.payload);
    assert_eq!(
        project_identity(&projected).unwrap().configuration_digest,
        resolved.configuration_digest
    );
    assert!(session.validate_manifest_compatibility(&projected).is_ok());
    let mut mismatched = projected;
    mismatched.compatibility = era_runtime_protocol::CompatibilityIdentity::default();
    assert!(
        session
            .validate_manifest_compatibility(&mismatched)
            .is_err()
    );
}

#[test]
fn browser_project_projection_keeps_resources_without_cloning_source_payloads() {
    let source = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 7,
        files: vec![
            SubmittedFile {
                relative_path: "ERB/main.erb".into(),
                category: FileCategory::Erb,
                payload: FilePayload::Utf8("@SYSTEM_TITLE\nRETURN\n".into()),
                content_hash: Some(ProtocolBytes::new(vec![1; 32])),
            },
            SubmittedFile {
                relative_path: "resources/title.png".into(),
                category: FileCategory::Resource,
                payload: FilePayload::Bytes(ProtocolBytes::new(vec![2, 3, 4])),
                content_hash: None,
            },
        ],
    };

    let (runtime, projected) = split_browser_project_manifest(source).unwrap();
    let source_identity = project_identity(&runtime).unwrap();

    assert_eq!(project_identity(&projected).unwrap(), source_identity);
    assert_eq!(project_identity(&runtime).unwrap(), source_identity);
    assert!(matches!(
        &projected.files[0].payload,
        FilePayload::Utf8(value) if value.is_empty()
    ));
    assert_eq!(
        projected.files[1].payload,
        FilePayload::Bytes(ProtocolBytes::new(vec![2, 3, 4]))
    );
    assert!(matches!(
        &runtime.files[0].payload,
        FilePayload::Utf8(value) if value == "@SYSTEM_TITLE\nRETURN\n"
    ));
    assert!(matches!(
        &runtime.files[1].payload,
        FilePayload::ExternalResource(resource) if resource.byte_length == 3
    ));
    assert_eq!(
        projected.files[1].content_hash.as_ref().unwrap().as_slice(),
        blake3::hash(&[2, 3, 4]).as_bytes()
    );
}

#[test]
fn decoded_project_file_load_projects_and_stages_a_valid_manifest() {
    let source = "@SYSTEM_TITLE\nRETURN\n";
    let resource = vec![2, 3, 4];
    let manifest = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 1,
        files: vec![
            SubmittedFile {
                relative_path: "ERB/main.erb".into(),
                category: FileCategory::Erb,
                payload: FilePayload::Utf8(source.into()),
                content_hash: Some(ProtocolBytes::new(
                    blake3::hash(source.as_bytes()).as_bytes().to_vec(),
                )),
            },
            SubmittedFile {
                relative_path: "resources/title.bin".into(),
                category: FileCategory::Resource,
                payload: FilePayload::Bytes(ProtocolBytes::new(resource.clone())),
                content_hash: Some(ProtocolBytes::new(
                    blake3::hash(&resource).as_bytes().to_vec(),
                )),
            },
        ],
    };
    let project_file = export_project_file(&manifest);
    let observed = inspect_project_file_identity(&project_file).unwrap();
    assert_eq!(observed.project_revision, 1);
    assert_eq!(observed.files[0].byte_length as usize, source.len());
    assert_eq!(
        observed.files[0].content_hash,
        blake3::hash(source.as_bytes()).to_hex().to_string()
    );
    assert_eq!(observed.files[0].payload_kind, "utf8");
    assert_eq!(observed.files[1].byte_length as usize, resource.len());
    assert_eq!(
        observed.files[1].content_hash,
        blake3::hash(&resource).to_hex().to_string()
    );
    assert!(inspect_project_file_identity(b"not a project").is_err());
    let decoded = era_runtime::decode_project_file(&project_file, project_file.len()).unwrap();
    let mut target = negotiated_web_session();

    let frontend = target
        .load_decoded_project_file(decoded)
        .expect("valid project file should stage its sources");

    assert_eq!(frontend.project_revision, manifest.project_revision);
    assert!(matches!(
        &frontend.files[0].payload,
        FilePayload::Utf8(value) if value.is_empty()
    ));
    assert!(matches!(
        &frontend.files[1].payload,
        FilePayload::Bytes(value) if value.as_slice() == resource
    ));
    wait_for_project_load(&mut target);
}

#[test]
fn project_file_cache_load_reuses_bytecode_and_externalizes_frontend_resources() {
    let source = "@SYSTEM_TITLE\nRETURN\n";
    let resource = vec![7, 8, 9];
    let manifest = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 1,
        files: vec![
            SubmittedFile {
                relative_path: "ERB/main.erb".into(),
                category: FileCategory::Erb,
                payload: FilePayload::Utf8(source.into()),
                content_hash: Some(ProtocolBytes::new(
                    blake3::hash(source.as_bytes()).as_bytes().to_vec(),
                )),
            },
            SubmittedFile {
                relative_path: "resources/title.bin".into(),
                category: FileCategory::Resource,
                payload: FilePayload::Bytes(ProtocolBytes::new(resource.clone())),
                content_hash: Some(ProtocolBytes::new(
                    blake3::hash(&resource).as_bytes().to_vec(),
                )),
            },
        ],
    };
    let project_file = export_project_file(&manifest);
    let mut target = negotiated_web_session();

    let (_, frontend) = target
        .load_project_file_cache(&project_file)
        .expect("valid project file should stage its compiled artifact");

    assert!(matches!(
        &frontend.files[0].payload,
        FilePayload::Utf8(value) if value.is_empty()
    ));
    assert!(matches!(
        &frontend.files[1].payload,
        FilePayload::Bytes(value) if value.as_slice() == resource
    ));
    let report = wait_for_runtime_event(&mut target, |message, _| match message {
        RuntimeMessage::ProjectLoadReport(report) => Some(report),
        _ => None,
    });
    assert!(report.success, "{:?}", report.diagnostics);
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "runtime.compiled_cache_hit")
    );
}

#[test]
fn owned_project_manifest_uses_a_lightweight_load_envelope() {
    let mut session = WebSession::new(WebSessionOptions {
        maximum_envelope_bytes: 1024 * 1024,
        ..WebSessionOptions::default()
    })
    .unwrap();
    session.pump(RuntimeDriveBudget::default()).unwrap();
    let source = format!(";{}\n@SYSTEM_TITLE\nRETURN\n", "x".repeat(2 * 1024 * 1024));
    let manifest = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 1,
        files: vec![SubmittedFile {
            relative_path: "ERB/main.erb".into(),
            category: FileCategory::Erb,
            payload: FilePayload::Utf8(source.clone()),
            content_hash: Some(ProtocolBytes::new(
                blake3::hash(source.as_bytes()).as_bytes().to_vec(),
            )),
        }],
    };

    assert!(session.load_project(manifest).is_ok());
}

#[test]
fn failed_lightweight_load_submission_rolls_back_the_owned_manifest() {
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    session.pump(RuntimeDriveBudget::default()).unwrap();
    let manifest = ProjectManifest {
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
        project_revision: 1,
        files: Vec::new(),
    };
    let original_maximum_envelope_bytes = session.wire_limits.maximum_envelope_bytes;
    session.wire_limits.maximum_envelope_bytes = 1;
    assert!(session.load_project(manifest.clone()).is_err());

    session.wire_limits.maximum_envelope_bytes = original_maximum_envelope_bytes;
    assert!(session.load_project(manifest).is_ok());
}

#[test]
fn configuration_digest_uses_payload_normalization_instead_of_the_declared_hash() {
    for source in [
        "[meta]\r\nschema_version = 4\r\n",
        "\u{feff}[meta]\r\nschema_version = 4\r\n",
    ] {
        let manifest = ProjectManifest {
            project_revision: 7,
            compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
            files: vec![SubmittedFile {
                relative_path: "reraconfig.toml".into(),
                category: FileCategory::Configuration,
                payload: FilePayload::Utf8(source.into()),
                content_hash: Some(ProtocolBytes::new(vec![9; 32])),
            }],
        };
        let identity = project_identity(&manifest).unwrap();
        let expected = Some(ProtocolBytes::new(
            blake3::hash(b"[meta]\nschema_version = 4\n")
                .as_bytes()
                .to_vec(),
        ));
        assert_eq!(identity.configuration_digest, expected);
        assert_ne!(
            identity.configuration_digest.as_ref().unwrap().as_slice(),
            &[9; 32]
        );
        let mut other_payload = manifest.clone();
        other_payload.files[0].payload = FilePayload::Utf8("different".into());
        assert_eq!(
            identity.source_digest,
            project_identity(&other_payload).unwrap().source_digest
        );
    }
    let manifest = ProjectManifest {
        project_revision: 7,
        files: vec![],
        compatibility: era_runtime_protocol::CompatibilityIdentity::default(),
    };
    assert_eq!(
        project_identity(&manifest).unwrap().configuration_digest,
        None
    );
}
