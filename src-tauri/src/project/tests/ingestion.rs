use super::*;
use era_runtime_protocol::CompatibilityProfileId;

fn packaged_host(path: PathBuf) -> ProjectHost {
    ProjectHost {
        root: path.parent().unwrap().to_owned(),
        manifest: None,
        indexed_files: Vec::new(),
        revision: 1,
        compatibility: CompatibilityIdentity::default(),
        embedded_resources: BTreeMap::new(),
        packaged_project: Some(PackagedProjectFile {
            storage_key: packaged_project_storage_key(&path),
            path,
            file_digest: [0; 32],
        }),
        runtime_manifest_sparse: false,
        pending_reload: None,
        source_index_stats: (0, 0),
    }
}

#[test]
fn core_resolution_is_required_before_selecting_snake_cache_storage() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("reraconfig.toml"),
        "[meta]\nschema_version = 4\n[compatibility]\nprofile = \"emuera.skia.snake\"\n",
    )
    .unwrap();
    let mut host = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let reference_path = host.compiled_cache_path();
    let mut session =
        era_web_bridge::WebSession::new(era_web_bridge::WebSessionOptions::default()).unwrap();
    assert!(host.resolve_compatibility(&session).is_err());
    session
        .pump(era_runtime::RuntimeDriveBudget::default())
        .unwrap();
    host.resolve_compatibility(&session).unwrap();
    assert_eq!(
        host.identity().compatibility.profile,
        CompatibilityProfileId::EmueraSkiaSnake
    );
    assert_ne!(host.compiled_cache_path(), reference_path);
    assert!(
        host.runtime_storage_root()
            .ends_with(".rustyera/profiles/emuera.skia.snake")
    );
    assert!(host.identity().configuration_digest.is_some());
}

#[test]
fn invalid_root_profile_does_not_rebind_storage() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("reraconfig.toml"),
        "[meta]\nschema_version = 4\n[compatibility]\nprofile = \"snake\"\n",
    )
    .unwrap();
    let mut host = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let before = host.identity();
    let mut session =
        era_web_bridge::WebSession::new(era_web_bridge::WebSessionOptions::default()).unwrap();
    session
        .pump(era_runtime::RuntimeDriveBudget::default())
        .unwrap();
    assert!(host.resolve_compatibility(&session).is_err());
    assert_eq!(host.identity(), before);
    assert!(!directory.path().join(".rustyera/profiles").exists());
}

#[test]
fn packaged_project_cache_is_scoped_with_its_runtime_storage() {
    let directory = tempfile::tempdir().unwrap();
    let mut first = packaged_host(directory.path().join("first.reraproj"));
    let mut second = packaged_host(directory.path().join("second.reraproj"));
    first.compatibility.profile = CompatibilityProfileId::EmueraSkiaSnake;
    second.compatibility.profile = CompatibilityProfileId::EmueraSkiaSnake;

    assert_ne!(first.compiled_cache_path(), second.compiled_cache_path());
    assert_eq!(
        first.runtime_storage_root(),
        first
            .runtime_save_root()
            .join(".rustyera/profiles/emuera.skia.snake")
    );
    assert_eq!(
        first.compiled_cache_path(),
        first
            .runtime_storage_root()
            .join("cache/compiled-project.reracache")
    );
    fs::create_dir_all(first.compiled_cache_path().parent().unwrap()).unwrap();
    fs::write(first.compiled_cache_path(), b"refreshed").unwrap();
    assert_eq!(first.compiled_cache().unwrap().unwrap(), b"refreshed");

    first.invalidate_compiled_cache();
    assert!(first.compiled_cache().unwrap().is_none());
}

#[test]
#[ignore = "invoked by the cross-frontend cache handoff scenario"]
fn cross_frontend_source_index_handoff_driver() {
    let project = PathBuf::from(
        std::env::var_os("RUSTYERA_TEST_TAURI_SOURCE_INDEX_PROJECT")
            .expect("handoff project path is required"),
    );
    let output = PathBuf::from(
        std::env::var_os("RUSTYERA_TEST_TAURI_SOURCE_INDEX_OUTPUT")
            .expect("handoff source-index output path is required"),
    );
    let relative_path = std::env::var("RUSTYERA_TEST_TAURI_EDIT_PATH")
        .expect("handoff source edit path is required");
    let expected = std::env::var("RUSTYERA_TEST_TAURI_EDIT_EXPECTED")
        .expect("handoff source edit expected text is required");
    let replacement = std::env::var("RUSTYERA_TEST_TAURI_EDIT_REPLACEMENT")
        .expect("handoff source edit replacement text is required");

    let warm = ProjectHost::scan_quick(&project, 1).expect("Tauri accepts the producer index");
    let (reused, hashed) = warm.source_index_stats();
    assert!(
        reused > 0,
        "Tauri must reuse the cross-frontend source index"
    );
    assert_eq!(hashed, 0, "a matching producer index must avoid rehashing");

    let source = project.join(relative_path);
    let contents = fs::read_to_string(&source).expect("handoff edit source is readable");
    assert_eq!(
        contents.matches(&expected).count(),
        1,
        "handoff edit marker must occur exactly once"
    );
    fs::write(&source, contents.replacen(&expected, &replacement, 1))
        .expect("handoff edit source is writable");

    let updated = ProjectHost::scan_quick(&project, 2).expect("Tauri updates the source index");
    assert_eq!(updated.source_index_stats(), (reused - 1, 1));
    let repeated = ProjectHost::scan_quick(&project, 3).expect("Tauri reuses its updated index");
    assert_eq!(repeated.source_index_stats(), (reused, 0));

    fs::copy(project.join(".rustyera/cache/source-index-v1.json"), output)
        .expect("Tauri source index is exported");
}

fn png_header(width: u32, height: u32) -> [u8; 24] {
    let mut bytes = [0_u8; 24];
    bytes[..16].copy_from_slice(&[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
    ]);
    bytes[16..20].copy_from_slice(&width.to_be_bytes());
    bytes[20..24].copy_from_slice(&height.to_be_bytes());
    bytes
}

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
fn sound_directory_audio_is_classified_as_a_resource() {
    let root = Path::new("/project");
    let canonical = BTreeSet::new();

    assert_eq!(
        classify(root, &root.join("sound/theme.mp3"), &canonical).unwrap(),
        Some(FileCategory::Resource)
    );
    assert_eq!(
        classify(root, &root.join("sound/cover.png"), &canonical).unwrap(),
        None
    );
}

#[test]
fn font_directory_files_are_binary_resources_for_cross_frontend_exports() {
    let root = Path::new("/project");
    let canonical = BTreeSet::new();
    for extension in ["ttf", "otf", "ttc", "woff", "woff2"] {
        let path = root.join(format!("FoNt/sample.{extension}"));
        assert_eq!(
            classify(root, &path, &canonical).unwrap(),
            Some(FileCategory::Resource)
        );
    }
    assert_eq!(
        classify(root, &root.join("font/license.txt"), &canonical).unwrap(),
        Some(FileCategory::Resource)
    );
}

#[test]
fn scanned_font_resources_remain_available_after_a_sparse_quick_scan() {
    let directory = tempfile::tempdir().unwrap();
    let fonts = directory.path().join("font");
    fs::create_dir(&fonts).unwrap();
    fs::write(fonts.join("Project.ttf"), b"font bytes").unwrap();
    fs::write(fonts.join("license.txt"), b"not packaged").unwrap();

    let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    let resources = project.font_sources();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].relative_path, "font/Project.ttf");
    assert_eq!(
        resources[0].content_hash,
        blake3::hash(b"font bytes").as_bytes()
    );
    assert_eq!(
        project.read_font("font/Project.ttf").unwrap(),
        b"font bytes"
    );
}

#[test]
fn resource_scan_uses_external_descriptor_and_full_export_restores_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let resources = directory.path().join("resources");
    fs::create_dir(&resources).unwrap();
    fs::write(resources.join("theme.ogg"), b"OggS example").unwrap();

    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let manifest = project.materialize().unwrap();
    assert!(matches!(
        &manifest.files[0].payload,
        FilePayload::ExternalResource(resource) if resource.byte_length == 12
    ));

    let mut full = Vec::new();
    let size = project
        .write_full_manifest_with_progress_and_cancel(&mut full, None, None)
        .unwrap();
    assert!(project.manifest.is_none());
    assert_eq!(usize::try_from(size).unwrap(), full.len());
    let decoded: ProjectManifest = era_protocol::decode_canonical(&full).unwrap();
    assert!(matches!(
        &decoded.files[0].payload,
        FilePayload::Bytes(bytes) if bytes.as_slice() == b"OggS example"
    ));
}

#[test]
fn resource_manifest_paths_are_normalized_to_nfc() {
    let directory = tempfile::tempdir().unwrap();
    let resources = directory.path().join("resources");
    fs::create_dir(&resources).unwrap();
    fs::write(
        resources.join("sprites.csv"),
        "FACE, e\u{301}.png \r\nANIME,anime\n",
    )
    .unwrap();

    let project = ProjectHost::scan_with_progress(directory.path(), 1, None).unwrap();
    let manifest = project.manifest.as_ref().unwrap();
    let resource_manifest = manifest
        .files
        .iter()
        .find(|file| file.relative_path == "resources/sprites.csv")
        .unwrap();

    assert!(matches!(
        &resource_manifest.payload,
        FilePayload::Utf8(text) if text == "FACE, \u{e9}.png \r\nANIME,anime\n"
    ));
}

#[test]
fn project_scan_matches_the_cross_frontend_cache_contract() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let resources = root.join("resources");
    let sound = root.join("sound");
    let fonts = root.join("font");
    let nested = root.join("sub");
    let private = root.join(".RUSTYERA/cache");
    for path in [&resources, &sound, &fonts, &nested, &private] {
        fs::create_dir_all(path).unwrap();
    }
    let decomposed = "e\u{301}.png";
    fs::write(resources.join(decomposed), b"png").unwrap();
    fs::write(
        resources.join("sprites.csv"),
        format!(
            "FACE, \t{decomposed} \t\r\nANIME, \tAnImE\t \nNOTE,\u{a0}{decomposed}\u{a0}\rMETA,a\u{85}b"
        ),
    )
    .unwrap();
    fs::write(sound.join("theme.MP3"), b"audio").unwrap();
    fs::write(fonts.join("Project.ttf"), b"font").unwrap();
    fs::write(sound.join("ignored.erb"), b"@IGNORED").unwrap();
    fs::write(private.join("ignored.erb"), b"@PRIVATE").unwrap();
    fs::write(root.join("reraconfig.toml"), b"[display]\nfont_size = 20\n").unwrap();
    fs::write(nested.join("reraconfig.toml"), b"\x82\xa0\n").unwrap();
    fs::write(root.join("\u{e9}.erb"), b"@ACCENTED\nRETURN\n").unwrap();
    fs::write(root.join("z.erb"), b"@ASCII\nRETURN\n").unwrap();

    let project = ProjectHost::scan_with_progress(root, 1, None).unwrap();
    let manifest = project.manifest.as_ref().unwrap();

    assert_eq!(
        manifest
            .files
            .iter()
            .map(|file| (file.relative_path.as_str(), file.category))
            .collect::<Vec<_>>(),
        vec![
            ("font/Project.ttf", FileCategory::Resource),
            ("reraconfig.toml", FileCategory::Configuration),
            ("resources/sprites.csv", FileCategory::ResourceManifest),
            ("resources/\u{e9}.png", FileCategory::Resource),
            ("sound/theme.MP3", FileCategory::Resource),
            ("sub/reraconfig.toml", FileCategory::Configuration),
            ("z.erb", FileCategory::Erb),
            ("\u{e9}.erb", FileCategory::Erb),
        ]
    );
    assert!(matches!(
        &manifest.files[2].payload,
        FilePayload::Utf8(text)
            if text == "FACE, \t\u{e9}.png \t\r\nANIME, \tAnImE\t \nNOTE,\u{a0}\u{e9}.png\u{a0}\rMETA,a\u{85}b"
    ));
    assert!(matches!(
        &manifest.files[5].payload,
        FilePayload::Utf8(text) if text == "\u{3042}\n"
    ));
    let digest: [u8; 32] = project
        .identity()
        .source_digest
        .as_slice()
        .try_into()
        .unwrap();
    assert_eq!(
        encode_hash(&digest),
        "2554d3820c88d26cf3ddd33ba9896e9cc6397ce28669772cd0abd60539b2ae2b"
    );
    let mut quick = ProjectHost::scan_quick(root, 1).unwrap();
    assert_eq!(quick.identity(), project.identity());
    assert_eq!(
        era_web_bridge::project_identity(quick.materialize().unwrap()).unwrap(),
        project.identity()
    );
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
    assert!(
        quick
            .indexed_files
            .iter()
            .all(|file| file.pending_file.is_some())
    );
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

#[test]
fn full_project_materialization_honors_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let erb = directory.path().join("ERB");
    fs::create_dir(&erb).unwrap();
    fs::write(erb.join("main.erb"), "@MAIN\nRETURN\n").unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let cancelled = AtomicBool::new(true);

    assert_eq!(
        project
            .materialize_with_progress_and_cancel(None, Some(&cancelled))
            .unwrap_err(),
        "full project export cancelled"
    );
    assert!(project.manifest.is_none());
    assert_eq!(project.source_index_stats(), (0, 1));

    cancelled.store(false, Ordering::Relaxed);
    assert!(
        project
            .materialize_with_progress_and_cancel(None, Some(&cancelled))
            .is_ok()
    );
    assert_eq!(project.source_index_stats(), (0, 1));
}

#[test]
fn parallel_reader_reports_the_lowest_input_error_deterministically() {
    let error = parallel_ordered(3, None, None, |index| {
        if index == 0 {
            thread::sleep(Duration::from_millis(20));
        }
        Err::<(), _>(format!("failure-{index}"))
    })
    .unwrap_err();

    assert_eq!(error, "failure-0");
}

#[test]
fn progress_gate_deduplicates_and_emits_boundaries() {
    let observed = RefCell::new(Vec::new());
    let callback = |completed, total| observed.borrow_mut().push((completed, total));
    let mut gate = ProgressGate::new(Some(&callback));

    gate.report(0, 10);
    gate.report(0, 10);
    gate.report(1, 10);
    gate.last_emitted = Instant::now().checked_sub(PROGRESS_INTERVAL).unwrap();
    gate.report(2, 10);
    gate.report(10, 10);

    assert_eq!(observed.into_inner(), [(0, 10), (2, 10), (10, 10)]);
}

#[test]
fn stable_read_retries_a_changed_signature_and_returns_the_matching_snapshot() {
    let signatures = RefCell::new(
        [
            [1, 0, 0, 0, 0],
            [2, 0, 0, 0, 0],
            [2, 0, 0, 0, 0],
            [2, 0, 0, 0, 0],
        ]
        .into_iter(),
    );
    let reads = RefCell::new(0);

    let (value, signature) = stable_read(
        "main.erb",
        || Ok(signatures.borrow_mut().next().unwrap()),
        || {
            *reads.borrow_mut() += 1;
            Ok(*reads.borrow())
        },
    )
    .unwrap();

    assert_eq!(value, 2);
    assert_eq!(signature, [2, 0, 0, 0, 0]);
}

#[test]
fn stable_read_and_scan_fail_after_bounded_continuous_changes() {
    let counter = RefCell::new(0_u64);
    let read_error = stable_read(
        "main.erb",
        || {
            *counter.borrow_mut() += 1;
            Ok([*counter.borrow(), 0, 0, 0, 0])
        },
        || Ok(()),
    )
    .unwrap_err();
    assert_eq!(
        read_error,
        "main.erb changed repeatedly while it was being read"
    );

    let attempts = RefCell::new(0);
    let scan_error = retry_stable_scan(|| {
        *attempts.borrow_mut() += 1;
        Err::<(), _>("project changed while it was being scanned".to_owned())
    })
    .unwrap_err();
    assert_eq!(*attempts.borrow(), STABLE_SCAN_ATTEMPTS);
    assert_eq!(
        scan_error,
        "project changed repeatedly while it was being scanned"
    );
}

#[test]
fn corrupt_source_index_is_rebuilt_from_file_contents() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("main.erb"), "@MAIN\nRETURN\n").unwrap();
    let index = directory
        .path()
        .join(".rustyera/cache/source-index-v1.json");
    fs::create_dir_all(index.parent().unwrap()).unwrap();
    fs::write(&index, b"not-json").unwrap();

    let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    assert_eq!(project.source_index_stats(), (0, 1));
    let stored: SourceIndex = serde_json::from_slice(&fs::read(index).unwrap()).unwrap();
    assert_eq!(stored.files.len(), 1);
}

#[test]
fn legacy_and_malformed_image_metadata_are_migrated_with_a_prefix_read() {
    for malformed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("resources");
        fs::create_dir(&resources).unwrap();
        fs::write(resources.join("image.png"), png_header(2, 3)).unwrap();
        ProjectHost::scan_quick(directory.path(), 1).unwrap();
        let index_path = directory
            .path()
            .join(".rustyera/cache/source-index-v1.json");
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        if malformed {
            index["version"] = 2.into();
            index["files"]["resources/image.png"]["image_metadata"] = serde_json::json!({
                "width": 0,
                "height": 3,
                "format": "invalid",
                "animated": false,
            });
        } else {
            index["version"] = 1.into();
            index["files"]["resources/image.png"]
                .as_object_mut()
                .unwrap()
                .remove("image_metadata");
        }
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();

        let mut warm = ProjectHost::scan_quick(directory.path(), 1).unwrap();

        assert_eq!(warm.source_index_stats(), (1, 0));
        let manifest = warm.materialize().unwrap();
        assert!(matches!(
            &manifest.files[0].payload,
            FilePayload::ExternalResource(ExternalResource {
                image_metadata: Some(ImageMetadataResponse {
                    width: 2,
                    height: 3,
                    format,
                    animated: false,
                }),
                ..
            }) if format == "png"
        ));
        let migrated: SourceIndex =
            serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        assert_eq!(migrated.version, SOURCE_INDEX_VERSION);
        assert!(
            migrated.files["resources/image.png"]
                .image_metadata
                .is_some()
        );
    }
}

#[test]
fn complete_index_reuses_all_files_and_partial_change_hashes_only_one() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("a.erb");
    let second = directory.path().join("b.erb");
    fs::write(&first, "@A\nRETURN\n").unwrap();
    fs::write(&second, "@B\nRETURN\n").unwrap();
    ProjectHost::scan_quick(directory.path(), 1).unwrap();

    let reused = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    assert_eq!(reused.source_index_stats(), (2, 0));

    fs::write(&second, "@B\nPRINTL CHANGED\nRETURN\n").unwrap();
    let partial = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    assert_eq!(partial.source_index_stats(), (1, 1));
}
