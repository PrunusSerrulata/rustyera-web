use super::*;
use era_runtime_protocol::FileChange;

#[test]
fn browser_index_migrates_to_portable_schema_and_keeps_incremental_reuse() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("main.erb");
    fs::write(&source, "@MAIN\nRETURN\n").unwrap();
    ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let index_path = directory
        .path()
        .join(".rustyera/cache/source-index-v1.json");
    let mut browser_index: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    browser_index["version"] = 2.into();
    browser_index["files"]["main.erb"]["category"] = "erb".into();
    fs::write(&index_path, serde_json::to_vec(&browser_index).unwrap()).unwrap();

    let migrated = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    assert_eq!(migrated.source_index_stats(), (1, 0));
    let canonical: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    assert_eq!(canonical["version"], SOURCE_INDEX_VERSION);
    assert_eq!(
        canonical["files"]["main.erb"]["category"],
        serde_json::json!(FileCategory::Erb as u8)
    );
    assert!(canonical["files"]["main.erb"]["signature"].is_string());

    fs::write(&source, "@MAIN\nPRINTL CHANGED\nRETURN\n").unwrap();
    let updated = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let repeated = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    assert_eq!(updated.source_index_stats(), (0, 1));
    assert_eq!(repeated.source_index_stats(), (1, 0));
}

#[test]
fn quick_scan_reads_the_real_path_while_submitting_an_nfc_protocol_path() {
    let directory = tempfile::tempdir().unwrap();
    let actual_name = "cafe\u{301}.erb";
    let actual_path = directory.path().join(actual_name);
    fs::write(&actual_path, "@SYSTEM_TITLE\nRETURN\n").unwrap();

    let mut quick = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let indexed = quick
        .indexed_files
        .iter()
        .find(|file| file.relative_path == "caf\u{e9}.erb")
        .unwrap();
    let canonical_actual = actual_path.canonicalize().unwrap();
    assert_eq!(
        indexed.source_path.as_deref(),
        Some(canonical_actual.as_path())
    );

    let manifest = quick.materialize().unwrap();
    assert!(
        manifest
            .files
            .iter()
            .any(|file| file.relative_path == "caf\u{e9}.erb")
    );
}

#[test]
fn native_scan_reports_discovery_and_completed_file_counts() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("main.erb"), "@SYSTEM_TITLE\nRETURN\n").unwrap();
    fs::write(directory.path().join("variables.csv"), "FLAG,1\n").unwrap();
    let observed = RefCell::new(Vec::new());
    let progress = |completed, total| observed.borrow_mut().push((completed, total));

    ProjectHost::scan_quick_with_progress(directory.path(), 1, Some(&progress)).unwrap();

    let observed = observed.into_inner();
    assert_eq!(observed[..2], [(0, 0), (0, 2)]);
    assert_eq!(observed.last(), Some(&(2, 2)));
}

#[test]
fn indexed_materialization_preserves_order_and_reports_each_file() {
    let directory = tempfile::tempdir().unwrap();
    for index in (0..16).rev() {
        fs::write(
            directory.path().join(format!("source-{index:02}.erb")),
            format!("@FUNCTION_{index}\nRETURN\n"),
        )
        .unwrap();
    }
    ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let mut indexed = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let observed = RefCell::new(Vec::new());
    let progress = |completed, total| observed.borrow_mut().push((completed, total));

    let manifest = indexed
        .take_manifest_with_progress(Some(&progress))
        .unwrap();

    let paths = manifest
        .files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<Vec<_>>();
    assert!(paths.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(observed.borrow().last(), Some(&(16, 16)));
    assert_eq!(
        era_web_bridge::project_identity(&manifest).unwrap(),
        indexed.identity()
    );
    assert!(indexed.manifest.is_none());
}

#[test]
fn quick_scan_rechecks_a_new_source_before_reusing_its_payload() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("main.erb");
    fs::write(&source, "@OLD\nRETURN\n").unwrap();
    let mut quick = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    fs::write(&source, "@NEW-CONTENT\nRETURN\n").unwrap();

    assert!(
        quick
            .materialize()
            .unwrap_err()
            .contains("project changed while its source files were being loaded")
    );
}

#[test]
fn reload_uses_the_indexed_baseline_after_a_file_is_removed() {
    let directory = tempfile::tempdir().unwrap();
    let fonts = directory.path().join("font");
    fs::create_dir(&fonts).unwrap();
    fs::write(directory.path().join("main.erb"), "@MAIN\nRETURN\n").unwrap();
    let removed = fonts.join("Project.ttf");
    fs::write(&removed, b"font bytes").unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();

    fs::remove_file(removed).unwrap();
    let request = project
        .reload_scoped_with_progress(&ProjectReloadScope::All, None)
        .unwrap();

    assert_eq!(request.base_revision, 1);
    assert_eq!(request.target_revision, 2);
    assert_eq!(request.changes.len(), 1);
    assert!(matches!(
        &request.changes[0],
        FileChange::Remove {
            category: FileCategory::Resource,
            relative_path,
        } if relative_path == "font/Project.ttf"
    ));
    project.finalize_reload(true);
    assert!(project.font_sources().is_empty());
}

#[test]
fn scoped_reload_retains_unselected_disk_changes_for_a_later_reload() {
    let directory = tempfile::tempdir().unwrap();
    let selected = directory.path().join("ERB/selected");
    let other = directory.path().join("ERB/other");
    fs::create_dir_all(&selected).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::write(
        selected.join("command.erb"),
        "@COM0\nPRINTL OLD\nRETURN 1\n",
    )
    .unwrap();
    fs::write(other.join("command.erb"), "@COM1\nPRINTL OLD\nRETURN 1\n").unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let submitted = project.take_manifest_with_progress(None).unwrap();
    assert_eq!(submitted.project_revision, 1);
    assert!(project.manifest.is_none());

    fs::write(
        selected.join("command.erb"),
        "@COM0\nPRINTL SELECTED\nRETURN 1\n",
    )
    .unwrap();
    fs::write(other.join("command.erb"), "@COM1\nPRINTL OTHER\nRETURN 1\n").unwrap();
    let selected_reload = project
        .reload_scoped_with_progress(
            &ProjectReloadScope::Folder {
                path: "ERB/selected".into(),
            },
            None,
        )
        .unwrap();

    assert_eq!(selected_reload.changes.len(), 1);
    assert!(selected_reload.changes.iter().any(|change| matches!(
        change,
        FileChange::Upsert { file }
            if file.relative_path == "ERB/selected/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
    )));
    project.finalize_reload(true);
    assert_eq!(project.revision, 2);
    assert!(project.manifest.is_none());

    let remaining_reload = project
        .reload_scoped_with_progress(
            &ProjectReloadScope::Script {
                path: "ERB/other/command.erb".into(),
            },
            None,
        )
        .unwrap();
    project.finalize_reload(true);
    assert_eq!(remaining_reload.changes.len(), 1);
    assert!(matches!(
        &remaining_reload.changes[0],
        FileChange::Upsert { file } if file.relative_path == "ERB/other/command.erb"
    ));
}

#[test]
fn sparse_scoped_reload_hydrates_from_current_sources_and_commits_only_on_success() {
    let directory = tempfile::tempdir().unwrap();
    let selected = directory.path().join("ERB/selected");
    let other = directory.path().join("ERB/other");
    fs::create_dir_all(&selected).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::write(
        selected.join("command.erb"),
        "@COM0\nPRINTL OLD\nRETURN 1\n",
    )
    .unwrap();
    fs::write(other.join("command.erb"), "@COM1\nPRINTL OLD\nRETURN 1\n").unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    project.take_manifest_with_progress(None).unwrap();
    project.mark_runtime_manifest_sparse();

    fs::write(
        selected.join("command.erb"),
        "@COM0\nPRINTL SELECTED\nRETURN 1\n",
    )
    .unwrap();
    fs::write(other.join("command.erb"), "@COM1\nPRINTL OTHER\nRETURN 1\n").unwrap();
    let error = project
        .reload_scoped_with_progress(
            &ProjectReloadScope::Folder {
                path: "ERB/selected".into(),
            },
            None,
        )
        .unwrap_err();
    assert!(error.contains("请改用全部重载"));

    fs::write(other.join("command.erb"), "@COM1\nPRINTL OLD\nRETURN 1\n").unwrap();
    let request = project
        .reload_scoped_with_progress(
            &ProjectReloadScope::Folder {
                path: "ERB/selected".into(),
            },
            None,
        )
        .unwrap();

    assert_eq!(request.base_revision, 1);
    assert_eq!(request.target_revision, 2);
    assert_eq!(request.changes.len(), 2);
    assert!(request.changes.iter().any(|change| matches!(
        change,
        FileChange::Upsert { file }
            if file.relative_path == "ERB/selected/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
    )));
    assert!(request.changes.iter().any(|change| matches!(
        change,
        FileChange::Upsert { file }
            if file.relative_path == "ERB/other/command.erb"
                && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
    )));
    project.finalize_reload(false);
    assert_eq!(project.revision, 1);
    assert!(project.manifest.is_none());
    assert!(project.runtime_manifest_sparse);

    project
        .reload_scoped_with_progress(
            &ProjectReloadScope::Folder {
                path: "ERB/selected".into(),
            },
            None,
        )
        .unwrap();
    project.finalize_reload(true);
    assert!(!project.runtime_manifest_sparse);
    assert!(project.manifest.is_none());
    let active = project.materialize().unwrap();
    assert_eq!(active.project_revision, 2);
    assert!(active.files.iter().any(|file| {
        file.relative_path == "ERB/selected/command.erb"
            && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL SELECTED"))
    }));
    assert!(active.files.iter().any(|file| {
        file.relative_path == "ERB/other/command.erb"
            && matches!(&file.payload, FilePayload::Utf8(text) if text.contains("PRINTL OLD"))
    }));
}

#[test]
fn reload_targets_include_current_and_removed_scripts() {
    let directory = tempfile::tempdir().unwrap();
    let commands = directory.path().join("ERB/commands");
    fs::create_dir_all(&commands).unwrap();
    fs::write(commands.join("hot.erb"), "@COM0\nRETURN 1\n").unwrap();
    let project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    fs::remove_file(commands.join("hot.erb")).unwrap();
    fs::write(commands.join("new.erh"), "#DIM TEST\n").unwrap();

    let targets = project.project_reload_targets().unwrap();

    assert_eq!(targets.folders, ["ERB/commands"]);
    assert_eq!(
        targets.scripts,
        ["ERB/commands/hot.erb", "ERB/commands/new.erh"]
    );
}

#[test]
fn configuration_write_checks_digest_and_atomically_replaces_root_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("reraconfig.toml");
    fs::write(&path, "[display]\r\nfont_size = 12\r\n").unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let digest = blake3::hash("[display]\nfont_size = 12\n".as_bytes());

    project
        .write_configuration(digest.as_bytes(), "[display]\nfont_size = 18\n")
        .unwrap();

    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "[display]\nfont_size = 18\n"
    );
    project
        .write_configuration(digest.as_bytes(), "[display]\r\nfont_size = 18\r\n")
        .unwrap();
    assert!(
        project
            .write_configuration(digest.as_bytes(), "[display]\nfont_size = 20\n")
            .unwrap_err()
            .contains("其他程序修改")
    );
}

#[test]
fn configuration_write_refreshes_the_manifest_used_for_full_project_export() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("main.erb"), "@SYSTEM_TITLE\nRETURN\n").unwrap();
    fs::write(
        directory.path().join("reraconfig.toml"),
        "[display]\nfont_size = 12\n",
    )
    .unwrap();
    let mut project = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let initial_identity = era_web_bridge::project_identity(project.materialize().unwrap())
        .expect("initial manifest has an identity");
    let digest = blake3::hash("[display]\nfont_size = 12\n".as_bytes());

    project
        .write_configuration(digest.as_bytes(), "[display]\nfont_size = 18\n")
        .unwrap();

    let (refreshed_identity, has_updated_configuration) = {
        let refreshed = project.materialize().unwrap();
        (
            era_web_bridge::project_identity(refreshed)
                .expect("refreshed manifest has an identity"),
            refreshed.files.iter().any(|file| {
                matches!(
                    &file.payload,
                    FilePayload::Utf8(contents)
                        if file.relative_path.eq_ignore_ascii_case("reraconfig.toml")
                            && contents == "[display]\nfont_size = 18\n"
                )
            }),
        )
    };
    assert_ne!(refreshed_identity, initial_identity);
    assert_eq!(refreshed_identity, project.identity());
    assert!(has_updated_configuration);
}

#[test]
fn reraconfig_requires_strict_utf8() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("reraconfig.toml"), [0x81]).unwrap();
    let Err(error) = ProjectHost::scan_quick(directory.path(), 1) else {
        panic!("non-UTF-8 reraconfig.toml must be rejected during the initial scan");
    };
    assert!(error.contains("valid UTF-8"));
}

#[test]
fn index_data_survives_native_warm_scan_materialization_and_scoped_reload() {
    let directory = tempfile::tempdir().unwrap();
    let indices = directory.path().join("ERB/indices");
    let csv = directory.path().join("CSV");
    fs::create_dir_all(&indices).unwrap();
    fs::create_dir_all(&csv).unwrap();
    fs::write(indices.join("BUFF.erd"), "\u{feff}10,主名\r\n").unwrap();
    fs::write(indices.join("BUFF.als"), "11,别名\n").unwrap();
    fs::write(csv.join("TRAIN.als"), "12,训练\n").unwrap();
    let cold = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let mut warm = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    assert_eq!(warm.source_index_stats, (3, 0));
    assert_eq!(warm.identity(), cold.identity());
    let materialized = warm.materialize().unwrap();
    assert_eq!(
        materialized
            .files
            .iter()
            .map(|file| file.category)
            .collect::<Vec<_>>(),
        [FileCategory::Als, FileCategory::Als, FileCategory::Erd]
    );
    assert!(matches!(
        &materialized.files[2].payload,
        FilePayload::Utf8(text) if text == "10,主名\r\n"
    ));
    assert!(
        warm.project_reload_targets()
            .unwrap()
            .scripts
            .contains(&"ERB/indices/BUFF.erd".into())
    );
    fs::write(indices.join("BUFF.als"), "13,更新\n").unwrap();
    fs::remove_file(indices.join("BUFF.erd")).unwrap();
    fs::write(indices.join("MATRIX@2.erd"), "10,新索引\n").unwrap();
    let reload = warm
        .reload_scoped_with_progress(
            &ProjectReloadScope::Folder {
                path: "ERB/indices".into(),
            },
            None,
        )
        .unwrap();
    assert_eq!(reload.changes.len(), 3);
    assert!(reload.changes.iter().any(|change| matches!(change,
        FileChange::Remove { category: FileCategory::Erd, relative_path }
            if relative_path == "ERB/indices/BUFF.erd"
    )));
    warm.finalize_reload(true);
    assert_ne!(warm.identity().source_digest, cold.identity().source_digest);
}

#[test]
fn index_data_uses_canonical_roots_and_strict_utf8() {
    let root = Path::new("/game");
    let roots = BTreeSet::from(["csv".into(), "erb".into()]);
    for (path, category) in [
        ("ERB/nested/BUFF.erd", FileCategory::Erd),
        ("ERB/nested/BUFF.als", FileCategory::Als),
        ("CSV/TRAIN.als", FileCategory::Als),
    ] {
        assert_eq!(
            classify(root, &root.join(path), &roots).unwrap(),
            Some(category)
        );
        assert!(normalized_project_text(path, b"\x82\xa0", category).is_none());
        assert_eq!(
            normalized_project_text(path, "\u{feff}10,索引\n".as_bytes(), category).unwrap(),
            "10,索引\n"
        );
    }
    for path in ["loose.erd", "CSV/BUFF.erd", "notes/BUFF.als"] {
        assert_eq!(classify(root, &root.join(path), &roots).unwrap(), None);
    }
    assert_eq!(
        classify(root, &root.join("flat.als"), &BTreeSet::new()).unwrap(),
        Some(FileCategory::Als)
    );
}

#[test]
fn data_resource_inventory_preserves_raw_bytes_without_loading_plugins() {
    let directory = tempfile::tempdir().unwrap();
    let plugins = directory.path().join("plugins");
    let saves = directory.path().join("sav");
    fs::create_dir(&plugins).unwrap();
    fs::create_dir(&saves).unwrap();
    let bytes = [0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0xff];
    for suffix in ["xml", "txt", "db", "sqlite", "dll"] {
        fs::write(plugins.join(format!("fixture.{suffix}")), bytes).unwrap();
    }
    fs::write(saves.join("txt00.txt"), "user save").unwrap();
    let cold = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    let mut warm = ProjectHost::scan_quick(directory.path(), 1).unwrap();
    assert_eq!(warm.identity(), cold.identity());
    assert_eq!(warm.source_index_stats, (4, 0));
    let files = warm.materialize().unwrap().files.clone();
    assert_eq!(files.len(), 4);
    for file in files {
        assert_eq!(file.category, FileCategory::Resource);
        assert!(matches!(&file.payload, FilePayload::ExternalResource(value)
            if value.byte_length == 6 && value.image_metadata.is_none()));
        assert_eq!(
            file.content_hash.unwrap().as_slice(),
            blake3::hash(&bytes).as_bytes()
        );
        assert_eq!(warm.read_resource(&file.relative_path).unwrap(), bytes);
    }
}

#[cfg(unix)]
#[test]
fn project_ingestion_rejects_external_symlinks_and_recursive_link_loops() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.xml"), "outside").unwrap();
    let link = directory.path().join("resource.xml");
    symlink(outside.path().join("secret.xml"), &link).unwrap();
    let Err(error) = ProjectHost::scan_quick(directory.path(), 1) else {
        panic!("external source link must be rejected");
    };
    assert!(error.contains("escapes the project root"));
    fs::remove_file(&link).unwrap();
    fs::write(outside.path().join("main.erb"), "@SYSTEM_TITLE\nRETURN\n").unwrap();
    let legacy_link = directory.path().join("main.erb");
    symlink(outside.path().join("main.erb"), &legacy_link).unwrap();
    assert!(ProjectHost::scan_quick(directory.path(), 1).is_ok());
    fs::remove_file(legacy_link).unwrap();
    fs::create_dir(directory.path().join("data")).unwrap();
    fs::write(directory.path().join("data/private.txt"), "private").unwrap();
    symlink(directory.path().join("data/private.txt"), &link).unwrap();
    let Err(error) = ProjectHost::scan_quick(directory.path(), 1) else {
        panic!("data overlay must not be exposed through a resource alias");
    };
    assert!(error.contains("writable or private storage"));
    fs::remove_file(&link).unwrap();
    symlink(directory.path(), directory.path().join("loop")).unwrap();
    let Err(error) = ProjectHost::scan_quick(directory.path(), 1) else {
        panic!("source link loop must be rejected");
    };
    assert!(error.contains("cannot scan project"));
}

#[test]
fn native_source_index_accepts_browser_index_data_names_and_codes() {
    for (category, code) in [("als", 6), ("erd", 7)] {
        let mut entry = serde_json::json!({
            "category": category,
            "signature": "10:1",
            "hash": "00".repeat(32),
            "size": 10,
        });
        let named: SourceIndexEntry = serde_json::from_value(entry.clone()).unwrap();
        assert_eq!(named.category, code);
        entry["category"] = code.into();
        let numbered: SourceIndexEntry = serde_json::from_value(entry).unwrap();
        assert_eq!(numbered.category, named.category);
    }
}

#[cfg(unix)]
#[test]
fn data_resources_recheck_authorization_before_read_prefix_and_export() {
    use std::os::unix::fs::symlink;
    for private in ["data", ".rustyera"] {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("seed.xml");
        fs::write(&source, "<seed>same inode and contents</seed>").unwrap();
        let mut host = ProjectHost::scan_quick(directory.path(), 1).unwrap();
        host.materialize().unwrap();
        fs::create_dir_all(directory.path().join(private)).unwrap();
        let moved = directory.path().join(private).join("seed.xml");
        fs::rename(&source, &moved).unwrap();
        symlink(moved, source).unwrap();
        for result in [
            host.read_resource("seed.xml"),
            host.read_resource_prefix("seed.xml", 8),
        ] {
            assert!(result.unwrap_err().contains("writable or private storage"));
        }
        let mut exported = Vec::new();
        assert!(
            host.write_full_manifest_with_progress_and_cancel(&mut exported, None, None)
                .unwrap_err()
                .contains("writable or private storage")
        );
    }
}
