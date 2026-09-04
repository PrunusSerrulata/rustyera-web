use super::*;

#[test]
fn traversal_is_rejected() {
    let root = Path::new("project");
    assert!(resolve(root, "../secret").is_err());
    assert!(resolve(root, "/secret").is_err());
}

#[test]
fn idempotent_results_evict_oldest_entries_at_the_capacity_limit() {
    let directory = tempfile::tempdir().unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());
    for index in 0..=MAXIMUM_IDEMPOTENT_RESULTS {
        storage.cache_idempotent(format!("key-{index}"), StorageResult::Deleted);
    }

    assert_eq!(storage.idempotent.len(), MAXIMUM_IDEMPOTENT_RESULTS);
    assert!(!storage.idempotent.contains_key("key-0"));
    assert!(
        storage
            .idempotent
            .contains_key(&format!("key-{MAXIMUM_IDEMPOTENT_RESULTS}"))
    );
    assert!(storage.idempotent_bytes <= MAXIMUM_IDEMPOTENT_BYTES);
}

#[test]
fn oversized_idempotent_results_are_not_cached() {
    let directory = tempfile::tempdir().unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());
    storage.cache_idempotent(
        "too-large".into(),
        StorageResult::Error {
            error: FrontendIoError {
                kind: FrontendIoErrorKind::Other,
                message: "x".repeat(MAXIMUM_IDEMPOTENT_BYTES),
                platform_code: None,
            },
        },
    );

    assert!(storage.idempotent.is_empty());
    assert_eq!(storage.idempotent_bytes, 0);
}

#[test]
fn storage_wire_tags_binary_data_and_unsafe_integers() {
    let request = decode_request(serde_json::json!({
        "request_id": { "$rustyeraInteger": "9007199254740992" },
        "namespace": "save",
        "relative_path": "save01.sav",
        "operation": {
            "type": "write",
            "data": { "$rustyeraBytes": "AID/" },
            "atomic_replace": true,
            "precondition": { "type": "any" }
        },
        "idempotency_key": "save-write",
        "deadline_ns": { "$rustyeraInteger": "9007199254740993" }
    }))
    .unwrap();
    assert_eq!(request.request_id, 9_007_199_254_740_992);
    assert_eq!(request.deadline_ns, Some(9_007_199_254_740_993));
    let StorageOperation::Write { data, .. } = request.operation else {
        panic!("expected decoded write operation");
    };
    assert_eq!(data.as_slice(), &[0, 0x80, 0xff]);
    assert!(
        decode_request(serde_json::json!({
            "request_id": 1,
            "namespace": "save",
            "relative_path": "save01.sav",
            "operation": {
                "type": "write",
                "data": [0, 128, 255],
                "atomic_replace": true,
                "precondition": { "type": "any" }
            },
            "idempotency_key": "save-write",
            "deadline_ns": null
        }))
        .is_err()
    );

    let encoded = serde_json::to_value(SafeStorageResponse(&StorageResponse {
        request_id: 9_007_199_254_740_992,
        result: StorageResult::ReadChunk {
            data: ProtocolBytes::new(vec![0, 0x80, 0xff]),
            offset: 9_007_199_254_740_993,
            complete: true,
            change_token: "token".into(),
        },
    }))
    .unwrap();
    assert_eq!(encoded["request_id"][IPC_INTEGER_TAG], "9007199254740992");
    assert_eq!(encoded["result"]["data"][IPC_BYTES_TAG], "AID/");
    assert_eq!(
        encoded["result"]["offset"][IPC_INTEGER_TAG],
        "9007199254740993"
    );
}

#[test]
fn storage_reads_and_paths_are_rejected_before_unbounded_allocation() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("sav")).unwrap();
    let oversized = directory.path().join("sav/oversized.sav");
    File::create(&oversized)
        .unwrap()
        .set_len((MAXIMUM_FULL_READ_BYTES as u64) + 1)
        .unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());

    let full = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Save,
        relative_path: "oversized.sav".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    assert!(matches!(full.result, StorageResult::Error { .. }));

    let range = storage.handle(StorageRequest {
        request_id: 2,
        namespace: StorageNamespace::Save,
        relative_path: "oversized.sav".into(),
        operation: StorageOperation::ReadRange {
            offset: 0,
            maximum_bytes: MAXIMUM_RANGE_READ_BYTES + 1,
            change_token: None,
        },
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    assert!(matches!(range.result, StorageResult::Error { .. }));

    let path = storage.handle(StorageRequest {
        request_id: 3,
        namespace: StorageNamespace::Save,
        relative_path: "x".repeat(MAXIMUM_RELATIVE_PATH_BYTES + 1),
        operation: StorageOperation::Stat,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    assert!(matches!(path.result, StorageResult::Error { .. }));
}

#[test]
fn storage_list_budget_limits_entry_count_and_retained_paths() {
    let mut retained_path_bytes = 0;
    assert!(account_list_entry(MAXIMUM_LIST_ENTRIES, &mut retained_path_bytes, 1).is_err());

    retained_path_bytes = MAXIMUM_LIST_PATH_BYTES;
    assert!(account_list_entry(0, &mut retained_path_bytes, 1).is_err());
}

#[test]
fn stat_hashes_with_a_fixed_buffer() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("sav")).unwrap();
    fs::write(directory.path().join("sav/save01.sav"), b"save data").unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());

    let response = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Save,
        relative_path: "save01.sav".into(),
        operation: StorageOperation::Stat,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Metadata(metadata) = response.result else {
        panic!("expected storage metadata");
    };
    let expected_revision = revision(b"save data");
    assert_eq!(metadata.byte_length, 9);
    assert_eq!(
        metadata.revision.as_deref(),
        Some(expected_revision.as_str())
    );
}

#[test]
fn snake_project_and_data_reads_never_fall_back_to_reference_sentinels() {
    for namespace in [StorageNamespace::Project, StorageNamespace::Data] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("shared")).unwrap();
        fs::write(root.join("shared/sentinel.xml"), b"reference sentinel").unwrap();
        let mut reference = StorageHost::new(root.to_owned());
        let mut snake = StorageHost::with_data_root(
            root.to_owned(),
            root.join(".rustyera/profiles/emuera.skia.snake"),
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        );
        for operation in [
            StorageOperation::Read,
            StorageOperation::Stat,
            StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: 64,
                change_token: None,
            },
            StorageOperation::List {
                pattern: Some("sentinel.xml".into()),
                recursive: false,
            },
        ] {
            let relative_path = if matches!(operation, StorageOperation::List { .. }) {
                "shared"
            } else {
                "shared/sentinel.xml"
            };
            let request = StorageRequest {
                request_id: 1,
                namespace,
                relative_path: relative_path.into(),
                operation,
                idempotency_key: String::new(),
                deadline_ns: None,
            };
            assert!(!matches!(
                reference.handle(request.clone()).result,
                StorageResult::Error { .. }
            ));
            let is_list = matches!(request.operation, StorageOperation::List { .. });
            let result = snake.handle(request).result;
            if is_list {
                assert!(matches!(result, StorageResult::Listed { entries } if entries.is_empty()));
            } else {
                assert!(matches!(result, StorageResult::Error { .. }));
            }
        }
        let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
        let request = StorageRequest {
            request_id: 2,
            namespace: StorageNamespace::Resource,
            relative_path: "shared/sentinel.xml".into(),
            operation: StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        };
        assert!(
            matches!(snake.handle_with_project(request, Some(&project)).result, StorageResult::Read { data, .. } if data.as_slice() == b"reference sentinel")
        );
    }
}

#[test]
fn snake_profile_uses_project_saves_and_isolates_other_runtime_data() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let snake = root.join(".rustyera/profiles/emuera.skia.snake");
    fs::create_dir_all(root.join("sav")).unwrap();
    fs::create_dir_all(snake.join("sav")).unwrap();
    fs::write(root.join("sav/save00.sav"), b"reference").unwrap();
    fs::write(snake.join("sav/save00.sav"), b"snake").unwrap();
    let mut storage = StorageHost::with_storage_roots(
        root.to_owned(),
        snake.clone(),
        root.to_owned(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    assert_eq!(storage.namespace_root(StorageNamespace::Resource), root);
    assert_eq!(
        storage.namespace_root(StorageNamespace::GlobalSave),
        root.join("sav")
    );
    let response = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Save,
        relative_path: "save00.sav".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Read { data, .. } = response.result else {
        panic!("expected project save");
    };
    assert_eq!(data.as_slice(), b"reference");
    assert_eq!(fs::read(root.join("sav/save00.sav")).unwrap(), b"reference");
    assert_eq!(
        storage.namespace_root(StorageNamespace::Data),
        snake.join("data")
    );
}

#[test]
fn traditional_save_management_routes_bytes_transparently_to_the_shared_save_root() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path();
    let private = project.join(".rustyera/profiles/emuera.skia.snake");
    let storage = StorageHost::with_storage_roots(
        project.to_owned(),
        private,
        project.to_owned(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    storage
        .write_traditional_save(1, b"opaque core-validated bytes")
        .unwrap();
    assert_eq!(
        storage.read_traditional_save(1).unwrap(),
        b"opaque core-validated bytes"
    );
    let slots = storage.list_traditional_save_slots(3).unwrap();
    assert_eq!(
        slots,
        vec![
            TraditionalSaveSlot {
                slot: 0,
                occupied: false
            },
            TraditionalSaveSlot {
                slot: 1,
                occupied: true
            },
            TraditionalSaveSlot {
                slot: 2,
                occupied: false
            },
        ]
    );
    assert!(
        !project
            .join(".rustyera/profiles/emuera.skia.snake/sav")
            .exists()
    );
}

#[test]
fn packaged_snake_project_separates_persistent_saves_from_private_data_and_logs() {
    let directory = tempfile::tempdir().unwrap();
    let resource_root = directory.path().join("package-source");
    let save_root = directory.path().join("packaged-projects/game-key");
    let data_root = save_root.join(".rustyera/profiles/emuera.skia.snake");
    fs::create_dir_all(&resource_root).unwrap();
    let mut storage = StorageHost::with_storage_roots(
        resource_root.clone(),
        data_root.clone(),
        save_root.clone(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );

    storage
        .write_traditional_save(0, b"shared 1808 save")
        .unwrap();
    for (request_id, namespace, relative_path) in [
        (1, StorageNamespace::Data, "state.db"),
        (2, StorageNamespace::Log, "runtime.log"),
    ] {
        let response = storage.handle(StorageRequest {
            request_id,
            namespace,
            relative_path: relative_path.into(),
            operation: StorageOperation::Write {
                data: ProtocolBytes::new(vec![u8::try_from(request_id).unwrap()]),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            },
            idempotency_key: format!("packaged-{request_id}"),
            deadline_ns: None,
        });
        assert!(matches!(response.result, StorageResult::Written { .. }));
    }

    assert_eq!(
        fs::read(save_root.join("sav/save00.sav")).unwrap(),
        b"shared 1808 save"
    );
    assert_eq!(fs::read(data_root.join("data/state.db")).unwrap(), [1]);
    assert_eq!(fs::read(data_root.join("logs/runtime.log")).unwrap(), [2]);
    assert!(!resource_root.join("sav").exists());
    assert!(!save_root.join("data").exists());
    assert!(!save_root.join("logs").exists());
}

#[test]
fn emuera_save_directory_is_used_for_slots_and_global_data() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("sav")).unwrap();
    fs::write(directory.path().join("sav/save01.sav"), b"slot").unwrap();
    fs::write(directory.path().join("sav/global.sav"), b"global").unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());

    let listed = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Save,
        relative_path: String::new(),
        operation: StorageOperation::List {
            pattern: Some("save*.sav".into()),
            recursive: false,
        },
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Listed { entries } = listed.result else {
        panic!("expected a save listing");
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relative_path, "save01.sav");

    let global = storage.handle(StorageRequest {
        request_id: 2,
        namespace: StorageNamespace::GlobalSave,
        relative_path: "global.sav".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Read { data, .. } = global.result else {
        panic!("expected global save data");
    };
    assert_eq!(data.as_slice(), b"global");
}

#[test]
fn data_operations_use_emuera_root_fallback_and_private_overrides() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("XML")).unwrap();
    fs::write(directory.path().join("XML/SKILL_LIFE.xml"), b"<project />").unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());

    let response = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Data,
        relative_path: "XML/SKILL_LIFE.xml".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });

    let StorageResult::Read { data, .. } = response.result else {
        panic!("expected project-root text data");
    };
    assert_eq!(data.as_slice(), b"<project />");

    let listed = storage.handle(StorageRequest {
        request_id: 2,
        namespace: StorageNamespace::Data,
        relative_path: "XML".into(),
        operation: StorageOperation::List {
            pattern: Some("SKILL*.xml".into()),
            recursive: false,
        },
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Listed { entries } = listed.result else {
        panic!("expected project-root XML listing");
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relative_path, "XML/SKILL_LIFE.xml");

    fs::create_dir_all(directory.path().join("data/XML")).unwrap();
    fs::write(
        directory.path().join("data/XML/SKILL_LIFE.xml"),
        b"<override />",
    )
    .unwrap();
    let override_read = storage.handle(StorageRequest {
        request_id: 3,
        namespace: StorageNamespace::Data,
        relative_path: "XML/SKILL_LIFE.xml".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    let StorageResult::Read { data, .. } = override_read.result else {
        panic!("expected private text data");
    };
    assert_eq!(data.as_slice(), b"<override />");

    let written = storage.handle(StorageRequest {
        request_id: 4,
        namespace: StorageNamespace::Data,
        relative_path: "XML/SKILL_LIFE.xml".into(),
        operation: StorageOperation::Write {
            data: ProtocolBytes::new(b"<written />".to_vec()),
            atomic_replace: true,
            precondition: StoragePrecondition::Any,
        },
        idempotency_key: String::new(),
        deadline_ns: None,
    });
    assert!(matches!(written.result, StorageResult::Written { .. }));
    assert_eq!(
        fs::read(directory.path().join("data/XML/SKILL_LIFE.xml")).unwrap(),
        b"<written />"
    );
    assert_eq!(
        fs::read(directory.path().join("XML/SKILL_LIFE.xml")).unwrap(),
        b"<project />"
    );
}

#[cfg(unix)]
#[test]
fn project_root_fallback_rejects_symlinks_that_escape_the_project() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("XML")).unwrap();
    fs::write(outside.path().join("secret.xml"), b"secret").unwrap();
    symlink(
        outside.path().join("secret.xml"),
        directory.path().join("XML/SKILL_LIFE.xml"),
    )
    .unwrap();
    let mut storage = StorageHost::new(directory.path().to_owned());

    let response = storage.handle(StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Data,
        relative_path: "XML/SKILL_LIFE.xml".into(),
        operation: StorageOperation::Read,
        idempotency_key: String::new(),
        deadline_ns: None,
    });

    let StorageResult::Error { error } = response.result else {
        panic!("expected a namespace permission error");
    };
    // Escaping an authorized namespace is a permission failure, never a missing-file fallback.
    assert_eq!(error.kind, FrontendIoErrorKind::PermissionDenied);
}
