use super::*;

#[test]
fn snake_data_normalized_paths_agree_with_resource_identity_and_mutate_existing_files() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir_all(root.join("plugins/café")).unwrap();
    fs::write(root.join("plugins/café/seed.txt"), b"source").unwrap();
    let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
    let private = root.join("private");
    let data = private.join("data");
    let actual = data.join("PlUgIns/Cafe\u{301}/SEED.TXT");
    fs::create_dir_all(actual.parent().unwrap()).unwrap();
    fs::write(&actual, b"overlay").unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        private,
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    for name in ["plugins/CAFÉ/seed.txt", "PLUGINS/cafe\u{301}/SEED.TXT"] {
        assert!(
            matches!(host.handle(data_request(name, StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
        );
        assert!(matches!(
            host.handle(data_request(name, StorageOperation::Stat))
                .result,
            StorageResult::Metadata(StorageMetadata { byte_length: 7, .. })
        ));
        assert!(
            matches!(host.handle(data_request(name, StorageOperation::ReadRange { offset: 1, maximum_bytes: 3, change_token: None })).result, StorageResult::ReadChunk { data, .. } if data.as_slice() == b"ver")
        );
    }
    let listed = host
        .handle(data_request(
            "pLuGiNs",
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ))
        .result;
    let StorageResult::Listed { entries } = listed else {
        panic!("expected normalized Data listing")
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["PlUgIns/Café/SEED.TXT"]
    );
    assert!(
        matches!(host.handle(data_request(&entries[0].relative_path, StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
    );
    assert!(
        matches!(host.handle_with_project(resource_request("PLUGINS/café/seed.txt", StorageOperation::Read), Some(&project)).result, StorageResult::Read { data, .. } if data.as_slice() == b"source")
    );
    let written = host
        .handle(data_request(
            "plugins/CAFÉ/Seed.Txt",
            StorageOperation::Write {
                data: ProtocolBytes::new(b"changed".to_vec()),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            },
        ))
        .result;
    assert!(matches!(written, StorageResult::Written { .. }));
    assert_eq!(fs::read(&actual).unwrap(), b"changed");
    assert_eq!(fs::read_dir(actual.parent().unwrap()).unwrap().count(), 1);
    assert!(matches!(
        host.handle(data_request(
            "New/e\u{301}.txt",
            StorageOperation::Write {
                data: ProtocolBytes::new(b"new".to_vec()),
                atomic_replace: false,
                precondition: StoragePrecondition::Any
            }
        ))
        .result,
        StorageResult::Written { .. }
    ));
    assert!(
        matches!(host.handle(data_request("new/É.TXT", StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"new")
    );
    assert!(matches!(
        host.handle(data_request(
            "PLUGINS/café/seed.txt",
            StorageOperation::Delete {
                precondition: StoragePrecondition::Any
            }
        ))
        .result,
        StorageResult::Deleted
    ));
    assert!(!actual.exists());
    assert!(
        matches!(host.handle(data_request("plugins/café/seed.txt", StorageOperation::Read)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::NotFound)
    );
    assert_eq!(
        fs::read(root.join("plugins/café/seed.txt")).unwrap(),
        b"source"
    );
}

#[cfg(unix)]
#[test]
fn snake_data_normalized_lookup_rejects_links_and_oversized_paths_before_writes() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let private = root.join("private");
    let data = private.join("data");
    fs::create_dir_all(&data).unwrap();
    let outside = root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("seed.txt"), b"private").unwrap();
    symlink(&outside, data.join("Escape")).unwrap();
    symlink(&data, data.join("Loop")).unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        private,
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    for (name, kind) in [
        (
            "escape/seed.txt".into(),
            FrontendIoErrorKind::PermissionDenied,
        ),
        ("loop/seed.txt".into(), FrontendIoErrorKind::InvalidData),
        ("a".repeat(4097), FrontendIoErrorKind::InvalidData),
        (vec!["a"; 257].join("/"), FrontendIoErrorKind::InvalidData),
    ] {
        for operation in [
            StorageOperation::Read,
            StorageOperation::Stat,
            StorageOperation::Delete {
                precondition: StoragePrecondition::Any,
            },
            StorageOperation::Write {
                data: ProtocolBytes::new(b"bad".to_vec()),
                atomic_replace: false,
                precondition: StoragePrecondition::Any,
            },
        ] {
            let result = host.handle(data_request(&name, operation)).result;
            assert!(matches!(result, StorageResult::Error { error } if error.kind == kind));
        }
    }
    assert_eq!(fs::read(outside.join("seed.txt")).unwrap(), b"private");
}

#[cfg(unix)]
#[test]
fn snake_data_namespace_link_does_not_reauthorize_an_outside_root() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let private = root.join("private");
    let outside = root.join("outside");
    fs::create_dir(&private).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("seed.txt"), b"safe").unwrap();
    symlink(&outside, private.join("data")).unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        private,
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    for operation in [
        StorageOperation::Read,
        StorageOperation::Write {
            data: ProtocolBytes::new(b"bad".to_vec()),
            atomic_replace: true,
            precondition: StoragePrecondition::Any,
        },
        StorageOperation::List {
            pattern: None,
            recursive: true,
        },
    ] {
        let name = if matches!(operation, StorageOperation::List { .. }) {
            ""
        } else {
            "seed.txt"
        };
        assert!(
            matches!(host.handle(data_request(name, operation)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
        );
    }
    assert_eq!(fs::read(outside.join("seed.txt")).unwrap(), b"safe");
}

#[cfg(unix)]
#[test]
fn storage_list_keeps_safe_alias_scope_and_original_does_not_follow_alias_subtrees() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let data = root.join("data");
    fs::create_dir_all(data.join("real")).unwrap();
    fs::write(data.join("real/A.txt"), b"alias contents").unwrap();
    symlink(data.join("real"), data.join("AliAs")).unwrap();
    let mut snake = StorageHost::with_data_root(
        root.to_owned(),
        root.to_owned(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    let StorageResult::Listed { entries } = snake
        .handle(data_request(
            "ALIAS",
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ))
        .result
    else {
        panic!("expected alias listing");
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["AliAs/A.txt"]
    );
    assert!(
        matches!(snake.handle(data_request("alias/a.TXT", StorageOperation::Read)).result, StorageResult::Read { data, .. } if data.as_slice() == b"alias contents")
    );
    assert!(matches!(
        snake
            .handle(data_request("alias/a.TXT", StorageOperation::Stat))
            .result,
        StorageResult::Metadata(StorageMetadata {
            byte_length: 14,
            ..
        })
    ));
    let mut original = StorageHost::new(root.to_owned());
    let StorageResult::Listed { entries } = original
        .handle(data_request(
            "",
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ))
        .result
    else {
        panic!("expected original listing");
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["real/A.txt"]
    );
}

#[test]
fn storage_list_rejects_target_disappeared_between_lookup_and_walk() {
    for profile in [
        era_runtime_protocol::CompatibilityProfileId::EmueraEm,
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("data/MiXeD");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir(root.join("MiXeD")).unwrap();
        fs::write(root.join("MiXeD/fallback.txt"), b"must not fall back").unwrap();
        let host = StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
        let snake = profile == era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake;
        let query = if snake { "mixed" } else { "MiXeD" };
        let resolved = host
            .resolve_for_read(StorageNamespace::Data, query)
            .unwrap();
        assert!(resolved.existed);
        fs::remove_dir(&target).unwrap();
        let error = listing::list_storage(&resolved, None, true, snake).unwrap_err();
        assert_eq!(frontend_error(&error).kind, FrontendIoErrorKind::Conflict);

        // Absence at the original lookup remains a successful empty list.
        let absent = host
            .resolve_for_read(StorageNamespace::Data, "absent")
            .unwrap();
        assert!(!absent.existed);
        assert!(
            matches!(listing::list_storage(&absent, None, true, snake).unwrap(), StorageResult::Listed { entries } if entries.is_empty())
        );
    }
}

#[test]
fn original_storage_fallback_keeps_its_target_presence_until_walk() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let target = root.join("fallback");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("seed.txt"), b"fallback").unwrap();
    let host = StorageHost::new(root.to_owned());
    let resolved = host
        .resolve_for_read(StorageNamespace::Data, "fallback")
        .unwrap();
    assert!(
        matches!(listing::list_storage(&resolved, None, true, false).unwrap(), StorageResult::Listed { entries } if entries.len() == 1 && entries[0].relative_path == "fallback/seed.txt")
    );
    fs::remove_file(target.join("seed.txt")).unwrap();
    fs::remove_dir(&target).unwrap();
    let error = listing::list_storage(&resolved, None, true, false).unwrap_err();
    assert_eq!(frontend_error(&error).kind, FrontendIoErrorKind::Conflict);
}

#[cfg(unix)]
#[test]
fn storage_list_rejects_dangling_entries_without_partial_results_or_namespace_fallback() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("data")).unwrap();
    fs::write(root.join("fallback.txt"), b"fallback").unwrap();
    fs::write(root.join("data/good.txt"), b"good").unwrap();
    symlink(root.join("missing"), root.join("data/dangling")).unwrap();
    for profile in [
        era_runtime_protocol::CompatibilityProfileId::EmueraEm,
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    ] {
        let mut host = StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
        assert!(
            matches!(host.handle(data_request("", StorageOperation::List { pattern: None, recursive: true })).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
        );
    }
}

#[cfg(unix)]
#[test]
fn storage_list_checks_actual_names_before_pattern_filtering_in_both_profiles() {
    for name in ["bad\\name.txt", "C:seed.txt"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("data/nested")).unwrap();
        fs::write(root.join("data/nested").join(name), b"invalid").unwrap();
        for profile in [
            era_runtime_protocol::CompatibilityProfileId::EmueraEm,
            era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
        ] {
            let mut host = StorageHost::with_data_root(root.to_owned(), root.to_owned(), profile);
            for path in ["", "nested"] {
                assert!(
                    matches!(host.handle(data_request(path, StorageOperation::List { pattern: Some("*.xml".into()), recursive: true })).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn storage_list_preserves_permission_denied_from_an_opened_subdirectory() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let nested = root.join("data/nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(root.join("data/good.txt"), b"good").unwrap();
    let permissions = fs::metadata(&nested).unwrap().permissions();
    fs::set_permissions(&nested, fs::Permissions::from_mode(0o0)).unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        root.to_owned(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    let result = host
        .handle(data_request(
            "",
            StorageOperation::List {
                pattern: None,
                recursive: true,
            },
        ))
        .result;
    fs::set_permissions(&nested, permissions).unwrap();
    assert!(
        matches!(result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
    );
}

#[test]
fn snake_storage_lists_share_pattern_rules_between_data_and_resource() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("data")).unwrap();
    // Use an isolated directory per Unicode filename: macOS can normalize directory names.
    for name in ["SEED.TXT", "😀.txt", "é.txt", "[ab].txt", "a.txt"] {
        fs::write(root.join(name), b"source").unwrap();
        fs::write(root.join("data").join(name), b"overlay").unwrap();
    }
    let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        root.to_owned(),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    for pattern in ["*.txt", "?.txt", "É.TXT", "[ab].txt", ""] {
        let operation = StorageOperation::List {
            pattern: Some(pattern.into()),
            recursive: true,
        };
        let StorageResult::Listed { entries: data } =
            host.handle(data_request("", operation.clone())).result
        else {
            panic!("expected Data listing");
        };
        let StorageResult::Listed { entries: resources } = host
            .handle_with_project(resource_request("", operation), Some(&project))
            .result
        else {
            panic!("expected Resource listing");
        };
        assert_eq!(
            data.iter()
                .map(|entry| &entry.relative_path)
                .collect::<Vec<_>>(),
            resources
                .iter()
                .map(|entry| &entry.relative_path)
                .collect::<Vec<_>>(),
            "{pattern}"
        );
    }
}

#[test]
fn resource_storage_authorizes_manifest_and_keeps_data_overlay_separate() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir_all(root.join("plugins/nested")).unwrap();
    fs::write(root.join("plugins/a.xml"), b"source").unwrap();
    fs::write(root.join("plugins/nested/b.txt"), b"nested").unwrap();
    fs::write(root.join("main.erb"), b"@MAIN\nRETURN\n").unwrap();
    let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
    let mut host = StorageHost::with_data_root(
        root.to_owned(),
        root.join("private"),
        era_runtime_protocol::CompatibilityProfileId::EmueraSkiaSnake,
    );
    fs::create_dir_all(root.join("private/data/plugins")).unwrap();
    fs::write(root.join("private/data/plugins/a.xml"), b"overlay").unwrap();
    let read = host.handle_with_project(
        resource_request("PLUGINS/a.xml", StorageOperation::Read),
        Some(&project),
    );
    assert!(
        matches!(read.result, StorageResult::Read { data, .. } if data.as_slice() == b"source")
    );
    let mut overlay = resource_request("plugins/a.xml", StorageOperation::Read);
    overlay.namespace = StorageNamespace::Data;
    assert!(
        matches!(host.handle(overlay).result, StorageResult::Read { data, .. } if data.as_slice() == b"overlay")
    );
    let listed = host.handle_with_project(
        resource_request(
            "plugins",
            StorageOperation::List {
                pattern: Some("*".into()),
                recursive: true,
            },
        ),
        Some(&project),
    );
    let StorageResult::Listed { entries } = listed.result else {
        panic!("expected resource listing")
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["plugins/a.xml", "plugins/nested/b.txt"]
    );
    let chunk = host.handle_with_project(
        resource_request(
            "plugins/a.xml",
            StorageOperation::ReadRange {
                offset: 2,
                maximum_bytes: 3,
                change_token: entries[0].change_token.clone(),
            },
        ),
        Some(&project),
    );
    assert!(
        matches!(chunk.result, StorageResult::ReadChunk { data, complete: false, .. } if data.as_slice() == b"urc")
    );
    let metadata = host.handle_with_project(
        resource_request("plugins/a.xml", StorageOperation::Stat),
        Some(&project),
    );
    assert!(matches!(
        metadata.result,
        StorageResult::Metadata(StorageMetadata {
            byte_length: 6,
            revision: Some(_)
        })
    ));
    for operation in [StorageOperation::Read, StorageOperation::Stat] {
        assert!(
            matches!(host.handle_with_project(resource_request("main.erb", operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
        );
    }
}

#[test]
fn resource_storage_rejects_mutation_before_paths_or_cached_results() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let mut host = StorageHost::new(root.to_owned());
    host.cache_idempotent("same".into(), StorageResult::Deleted);
    for operation in [
        StorageOperation::Write {
            data: ProtocolBytes::new(vec![1]),
            atomic_replace: true,
            precondition: StoragePrecondition::Any,
        },
        StorageOperation::Delete {
            precondition: StoragePrecondition::Any,
        },
    ] {
        let mut request = resource_request("missing/sub/seed.xml", operation);
        request.idempotency_key = "same".into();
        assert!(
            matches!(host.handle(request).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::ReadOnly)
        );
    }
    assert!(!root.join("missing").exists());
}

#[test]
fn resource_storage_detects_changes_and_rejects_invalid_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::write(root.join("seed.xml"), b"one").unwrap();
    let project = crate::project::ProjectHost::scan_with_progress(root, 1, None).unwrap();
    let mut host = StorageHost::new(root.to_owned());
    for operation in [
        StorageOperation::ReadRange {
            offset: 0,
            maximum_bytes: 0,
            change_token: None,
        },
        StorageOperation::ReadRange {
            offset: 0,
            maximum_bytes: MAXIMUM_RANGE_READ_BYTES + 1,
            change_token: None,
        },
    ] {
        assert!(
            matches!(host.handle_with_project(resource_request("seed.xml", operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
        );
    }
    assert!(
        matches!(host.handle_with_project(resource_request("seed.xml", StorageOperation::ReadRange { offset: 0, maximum_bytes: 1, change_token: Some("old".into()) }), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
    );
    fs::write(root.join("seed.xml"), b"two").unwrap();
    for operation in [
        StorageOperation::Read,
        StorageOperation::Stat,
        StorageOperation::ReadRange {
            offset: 0,
            maximum_bytes: 1,
            change_token: None,
        },
        StorageOperation::List {
            pattern: None,
            recursive: true,
        },
    ] {
        let relative = if matches!(operation, StorageOperation::List { .. }) {
            ""
        } else {
            "seed.xml"
        };
        assert!(
            matches!(host.handle_with_project(resource_request(relative, operation), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
        );
    }
}

#[cfg(unix)]
#[test]
fn resource_storage_and_data_listing_reject_link_escape_and_cycles() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("game");
    fs::create_dir_all(root.join("data")).unwrap();
    fs::write(root.join("seed.xml"), b"seed").unwrap();
    let project = crate::project::ProjectHost::scan_with_progress(&root, 1, None).unwrap();
    let mut host = StorageHost::new(root.clone());
    let outside = directory.path().join("outside.xml");
    fs::write(&outside, b"outside").unwrap();
    fs::remove_file(root.join("seed.xml")).unwrap();
    symlink(&outside, root.join("seed.xml")).unwrap();
    assert!(
        matches!(host.handle_with_project(resource_request("seed.xml", StorageOperation::Read), Some(&project)).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
    );
    symlink(root.join("data"), root.join("data/loop")).unwrap();
    let mut request = resource_request(
        "",
        StorageOperation::List {
            pattern: None,
            recursive: true,
        },
    );
    request.namespace = StorageNamespace::Data;
    assert!(
        matches!(host.handle(request.clone()).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::InvalidData)
    );
    fs::remove_file(root.join("data/loop")).unwrap();
    symlink(&outside, root.join("data/out.xml")).unwrap();
    assert!(
        matches!(host.handle(request).result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::PermissionDenied)
    );
}
