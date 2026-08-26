use super::*;
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FilePayload, SnapshotExportPurpose, StateExportChunk, StateExportChunkRequest,
    StateExportKind, StateExportRequest, StateExportResult, StateImportBegin, StateImportChunk,
    StateImportCommit, StateTransferDescriptor, SubmittedFile,
};
use std::collections::VecDeque;

#[test]
fn session_negotiates_and_projects_server_hello() {
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    let batch = session.pump(RuntimeDriveBudget::default()).unwrap();
    assert!(batch.events.iter().any(|event| {
        event.channel == WebChannel::Runtime
            && event
                .message
                .get("type")
                .and_then(serde_json::Value::as_str)
                == Some("server_hello")
    }));
    assert!(session.is_negotiated());
    let hello = batch
        .events
        .iter()
        .find(|event| event.message["type"] == "server_hello")
        .unwrap();
    assert_eq!(
        hello.message["value"]["implementation_version"],
        era_runtime::VERSION
    );
}

#[test]
fn state_export_chunks_project_bulk_bytes_separately() {
    let original = vec![0, 1, 0x80, 0xff];
    let (message, data_bytes) =
        project_runtime_message(RuntimeMessage::StateExportChunk(StateExportChunk {
            transfer_id: 7,
            offset: 9,
            data: ProtocolBytes::new(original.clone()),
            complete: false,
        }));

    assert_eq!(data_bytes.unwrap().0, original);
    assert_eq!(message.unwrap()["value"]["data"], serde_json::json!([]));

    let (message, data_bytes) =
        project_runtime_message(RuntimeMessage::Acknowledge(SequenceAcknowledgement {
            through_sequence: 3,
        }));
    assert!(data_bytes.is_none());
    assert_eq!(message.unwrap()["type"], "acknowledge");
}

#[test]
fn client_advertises_canvas_image_decode() {
    let hello = client_hello(
        WebSessionOptions::default(),
        RuntimeLimits {
            maximum_envelope_bytes: DEFAULT_ENVELOPE_BYTES,
            maximum_payload_bytes: DEFAULT_ENVELOPE_BYTES - 1024 * 1024,
            maximum_pending_requests: 128,
            maximum_journal_entries: 4096,
            maximum_journal_bytes: 64 * 1024 * 1024,
            maximum_drive_instructions: 1_000_000,
            maximum_transfer_bytes: DEFAULT_ENVELOPE_BYTES - 1024 * 1024,
        },
    );
    assert!(hello.capabilities.services.iter().any(|capability| {
        capability.kind == ServiceKind::Canvas && capability.operation == "decode_canvas_image"
    }));
}

#[test]
fn web_session_negotiates_one_gibibyte_transfer_limit() {
    let session = WebSession::new(WebSessionOptions::default()).unwrap();
    assert_eq!(session.maximum_transfer_bytes(), 1024 * 1024 * 1024);
}

#[test]
fn native_storage_partition_honors_zero_and_exact_limits() {
    let mut calls = 0;
    let events = vec![test_event("before"), storage_event(1), test_event("after")];
    let (visible, responses) = extract_native_events(
        events,
        0,
        |_| {
            calls += 1;
            unreachable!("zero storage allowance must not invoke the host")
        },
        |_| None,
    )
    .unwrap();
    assert_eq!(calls, 0);
    assert!(responses.is_empty());
    assert_eq!(
        event_types(&visible),
        ["before", "storage_request", "after"]
    );

    let events = vec![
        test_event("before"),
        storage_event(1),
        test_event("middle"),
        storage_event(2),
        test_event("after"),
    ];
    let (visible, responses) = extract_native_events(
        events,
        1,
        |request| {
            calls += 1;
            StorageResponse {
                request_id: request.request_id,
                result: era_runtime_protocol::StorageResult::Error {
                    error: era_runtime_protocol::FrontendIoError {
                        kind: era_runtime_protocol::FrontendIoErrorKind::NotFound,
                        message: "fixture".into(),
                        platform_code: None,
                    },
                },
            }
        },
        |_| None,
    )
    .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(responses.len(), 1);
    assert!(matches!(
        &responses[0].message,
        RuntimeMessage::StorageResponse(response) if response.request_id == 1
    ));
    assert_eq!(
        event_types(&visible),
        ["before", "middle", "storage_request", "after"]
    );
}

#[test]
fn native_storage_pump_preserves_visible_event_order_across_rounds() {
    let mut combined = None;
    merge_pump_batch(
        &mut combined,
        batch(
            WebDriveState::OutputReady,
            10,
            1,
            vec![test_event("before_storage")],
        ),
    );
    merge_pump_batch(
        &mut combined,
        batch(
            WebDriveState::Idle,
            20,
            2,
            vec![test_event("after_storage")],
        ),
    );
    let combined = combined.unwrap();
    assert_eq!(
        event_types(&combined.events),
        ["before_storage", "after_storage"]
    );
    assert_eq!(combined.vm_instructions, 30);
    assert_eq!(combined.runtime_transitions, 3);
    assert_eq!(combined.state, WebDriveState::Idle);

    let mut saturated = Some(batch(
        WebDriveState::MoreWork,
        u64::MAX,
        u32::MAX,
        Vec::new(),
    ));
    merge_pump_batch(&mut saturated, batch(WebDriveState::Idle, 1, 1, Vec::new()));
    let saturated = saturated.unwrap();
    assert_eq!(saturated.vm_instructions, u64::MAX);
    assert_eq!(saturated.runtime_transitions, u32::MAX);
}

#[test]
fn bounded_native_driver_applies_one_global_external_cap_and_keeps_event_order() {
    let mut driver = FakeNativePumpDriver::new([
        batch(
            WebDriveState::OutputReady,
            10,
            1,
            vec![test_event("before"), storage_event(1), test_event("middle")],
        ),
        batch(
            WebDriveState::OutputReady,
            20,
            2,
            vec![
                storage_event(2),
                test_event("between"),
                storage_event(3),
                test_event("after"),
            ],
        ),
    ]);
    let mut host_calls = 0;

    let combined = drive_native_until_blocked(
        &mut driver,
        16,
        2,
        |request| {
            host_calls += 1;
            missing_storage_response(&request)
        },
        |_| None,
    )
    .unwrap();

    assert_eq!(driver.pump_calls, 2);
    assert_eq!(host_calls, 2);
    assert_eq!(driver.submitted_request_ids(), [1, 2]);
    assert_eq!(
        event_types(&combined.events),
        ["before", "middle", "between", "storage_request", "after"]
    );
    assert_eq!(combined.state, WebDriveState::MoreWork);
}

#[test]
fn bounded_native_driver_submits_completion_then_continues_to_blocked_state() {
    let mut driver = FakeNativePumpDriver::new([
        batch(
            WebDriveState::OutputReady,
            10,
            1,
            vec![test_event("before"), storage_event(1)],
        ),
        batch(WebDriveState::Idle, 20, 2, vec![test_event("after")]),
    ]);

    let combined = drive_native_until_blocked(
        &mut driver,
        16,
        4,
        |request| missing_storage_response(&request),
        |_| None,
    )
    .unwrap();

    assert_eq!(driver.pump_calls, 2);
    assert_eq!(driver.submitted_request_ids(), [1]);
    assert_eq!(event_types(&combined.events), ["before", "after"]);
    assert_eq!(combined.vm_instructions, 30);
    assert_eq!(combined.runtime_transitions, 3);
    assert_eq!(combined.state, WebDriveState::Idle);
}

#[test]
fn bounded_native_driver_yields_immediately_for_cooperative_work() {
    let mut cooperative = batch(WebDriveState::OutputReady, 10, 1, vec![storage_event(1)]);
    cooperative.cooperative_background_work = true;
    let mut driver = FakeNativePumpDriver::new([
        cooperative,
        batch(WebDriveState::Idle, 20, 2, vec![test_event("late")]),
    ]);

    let combined = drive_native_until_blocked(
        &mut driver,
        16,
        4,
        |request| missing_storage_response(&request),
        |_| None,
    )
    .unwrap();

    assert_eq!(driver.pump_calls, 1);
    assert_eq!(driver.submitted_request_ids(), [1]);
    assert!(combined.cooperative_background_work);
    assert_eq!(combined.state, WebDriveState::MoreWork);
}

#[test]
fn bounded_native_driver_never_overwrites_terminal_state_after_completion() {
    for state in [WebDriveState::Stopped, WebDriveState::Faulted] {
        for trigger in ["external_cap", "batch_cap", "cooperative"] {
            let mut terminal = batch(state, 10, 1, vec![storage_event(1)]);
            terminal.cooperative_background_work = trigger == "cooperative";
            let mut driver = FakeNativePumpDriver::new([terminal]);
            let maximum_batches = if trigger == "batch_cap" { 1 } else { 16 };
            let maximum_external_requests = if trigger == "external_cap" { 1 } else { 4 };

            let combined = drive_native_until_blocked(
                &mut driver,
                maximum_batches,
                maximum_external_requests,
                |request| missing_storage_response(&request),
                |_| None,
            )
            .unwrap();

            assert_eq!(driver.submitted_request_ids(), [1], "trigger={trigger}");
            assert_eq!(combined.state, state, "trigger={trigger}");
        }
    }
}

#[test]
fn quiet_pump_returns_immediately_for_an_observable_batch() {
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    let batch = session
        .pump_quiet(
            RuntimeDriveBudget::default(),
            FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
        )
        .unwrap();
    assert!(!batch.events.is_empty());
    assert!(session.is_negotiated());
}

#[test]
fn quiet_pump_coalesces_more_work_until_the_first_event() {
    let mut batches = VecDeque::from([
        Ok(batch(WebDriveState::MoreWork, 10, 1, vec![])),
        Ok(batch(WebDriveState::MoreWork, 20, 2, vec![])),
        Ok(batch(
            WebDriveState::OutputReady,
            30,
            3,
            vec![test_event("diagnostic")],
        )),
        Ok(batch(WebDriveState::Idle, 40, 4, vec![])),
    ]);

    let combined = coalesce_quiet_pumps(|| batches.pop_front().unwrap(), 16).unwrap();

    assert_eq!(combined.state, WebDriveState::OutputReady);
    assert_eq!(combined.vm_instructions, 60);
    assert_eq!(combined.runtime_transitions, 6);
    assert_eq!(combined.events.len(), 1);
    assert_eq!(batches.len(), 1);
}

#[test]
fn quiet_pump_stops_exactly_at_the_slice_cap() {
    let mut calls = 0;
    let combined = coalesce_quiet_pumps(
        || {
            calls += 1;
            Ok(batch(WebDriveState::MoreWork, 7, 2, vec![]))
        },
        3,
    )
    .unwrap();

    assert_eq!(calls, 3);
    assert_eq!(combined.vm_instructions, 21);
    assert_eq!(combined.runtime_transitions, 6);
    assert_eq!(combined.state, WebDriveState::MoreWork);
}

#[test]
fn quiet_pump_returns_after_one_cooperative_background_quantum() {
    let mut calls = 0;
    let combined = coalesce_quiet_pumps(
        || {
            calls += 1;
            let mut result = batch(WebDriveState::MoreWork, 0, 0, vec![]);
            result.cooperative_background_work = true;
            Ok(result)
        },
        16,
    )
    .unwrap();

    assert_eq!(calls, 1);
    assert!(combined.cooperative_background_work);
}

#[test]
fn quiet_pump_does_not_continue_terminal_or_blocked_states() {
    for state in [
        WebDriveState::Idle,
        WebDriveState::Stopped,
        WebDriveState::Faulted,
    ] {
        let mut calls = 0;
        let combined = coalesce_quiet_pumps(
            || {
                calls += 1;
                Ok(batch(state, 1, 1, vec![]))
            },
            16,
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(combined.state, state);
    }
}

#[test]
fn quiet_pump_propagates_a_later_slice_error() {
    let mut batches = VecDeque::from([
        Ok(batch(WebDriveState::MoreWork, 10, 1, vec![])),
        Err("drive failed".to_owned()),
    ]);

    let error = coalesce_quiet_pumps(|| batches.pop_front().unwrap(), 16).unwrap_err();

    assert_eq!(error, "drive failed");
}

#[test]
fn observable_pump_retains_event_order_and_saturates_work_totals() {
    let mut batches = VecDeque::from([
        Ok(batch(
            WebDriveState::OutputReady,
            u64::MAX,
            u32::MAX,
            vec![test_event("first")],
        )),
        Ok(batch(
            WebDriveState::OutputReady,
            1,
            1,
            vec![test_event("second")],
        )),
        Ok(batch(WebDriveState::Idle, 1, 1, vec![test_event("last")])),
    ]);

    let combined = coalesce_observable_pumps(|| batches.pop_front().unwrap(), 16).unwrap();

    assert_eq!(event_types(&combined.events), ["first", "second", "last"]);
    assert_eq!(combined.vm_instructions, u64::MAX);
    assert_eq!(combined.runtime_transitions, u32::MAX);
    assert_eq!(combined.state, WebDriveState::Idle);
}

#[test]
fn observable_pump_stops_exactly_at_the_batch_cap() {
    let mut calls = 0;
    let combined = coalesce_observable_pumps(
        || {
            calls += 1;
            Ok(batch(WebDriveState::OutputReady, 7, 2, vec![]))
        },
        3,
    )
    .unwrap();

    assert_eq!(calls, 3);
    assert_eq!(combined.vm_instructions, 21);
    assert_eq!(combined.runtime_transitions, 6);
    assert_eq!(combined.state, WebDriveState::OutputReady);
}

#[test]
fn observable_pump_yields_after_cooperative_or_terminal_work() {
    let mut cooperative_calls = 0;
    let cooperative = coalesce_observable_pumps(
        || {
            cooperative_calls += 1;
            let mut result = batch(WebDriveState::OutputReady, 1, 1, vec![]);
            result.cooperative_background_work = true;
            Ok(result)
        },
        16,
    )
    .unwrap();
    assert_eq!(cooperative_calls, 1);
    assert!(cooperative.cooperative_background_work);

    for state in [
        WebDriveState::Idle,
        WebDriveState::Stopped,
        WebDriveState::Faulted,
    ] {
        let mut calls = 0;
        let combined = coalesce_observable_pumps(
            || {
                calls += 1;
                Ok(batch(state, 1, 1, vec![]))
            },
            16,
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(combined.state, state);
    }
}

#[test]
fn observable_pump_propagates_a_later_batch_error() {
    let mut batches = VecDeque::from([
        Ok(batch(WebDriveState::OutputReady, 10, 1, vec![])),
        Err("drive failed".to_owned()),
    ]);

    let error = coalesce_observable_pumps(|| batches.pop_front().unwrap(), 16).unwrap_err();

    assert_eq!(error, "drive failed");
}

#[test]
fn project_identity_matches_the_cross_host_fixed_vector() {
    let make = |path: &str, category: FileCategory, digest: Vec<u8>| SubmittedFile {
        relative_path: path.into(),
        category,
        payload: FilePayload::Utf8(String::from("@TEST\nRETURN")),
        content_hash: Some(ProtocolBytes::new(digest)),
    };
    let left = ProjectManifest {
        project_revision: 7,
        files: vec![
            make("ERB/a.erb", FileCategory::Erb, vec![1; 32]),
            make("ERB/A.erb", FileCategory::Erh, vec![2; 32]),
            make("CSV/config.csv", FileCategory::Csv, (0_u8..32).collect()),
            make("resources/icon.png", FileCategory::Resource, vec![255; 32]),
        ],
    };
    let right = ProjectManifest {
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
fn browser_project_projection_keeps_resources_without_cloning_source_payloads() {
    let source = ProjectManifest {
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
        project_revision: 1,
        files: Vec::new(),
    };
    let original_maximum_envelope_bytes = session.wire_limits.maximum_envelope_bytes;
    session.wire_limits.maximum_envelope_bytes = 1;
    assert!(session.load_project(manifest.clone()).is_err());

    session.wire_limits.maximum_envelope_bytes = original_maximum_envelope_bytes;
    assert!(session.load_project(manifest).is_ok());
}

fn negotiated_web_session() -> WebSession {
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    session.pump(RuntimeDriveBudget::default()).unwrap();
    assert!(session.is_negotiated());
    session
}

fn wait_for_project_load(session: &mut WebSession) {
    wait_for_runtime_event(session, |message, _| match message {
        RuntimeMessage::ProjectLoadReport(report) => {
            assert!(report.success, "{:?}", report.diagnostics);
            Some(())
        }
        _ => None,
    });
}

fn export_project_file(manifest: &ProjectManifest) -> Vec<u8> {
    let mut session = negotiated_web_session();
    session.load_project(manifest.clone()).unwrap();
    wait_for_project_load(&mut session);
    stage_full_project_manifest(&mut session, manifest);
    let descriptor = prepare_full_project_export(&mut session);
    read_project_file(&mut session, &descriptor)
}

fn stage_full_project_manifest(session: &mut WebSession, manifest: &ProjectManifest) {
    let encoded_manifest = era_protocol::encode_canonical(manifest).unwrap();
    session
        .submit_runtime(
            &RuntimeMessage::StateImportBegin(StateImportBegin {
                kind: StateExportKind::FullProjectManifest,
                total_bytes: encoded_manifest.len() as u64,
                digest: None,
                artifact_id: None,
            }),
            None,
        )
        .unwrap();
    let transfer_id = wait_for_runtime_event(session, |message, _| match message {
        RuntimeMessage::StateImportAccepted(accepted) => Some(accepted.transfer_id),
        RuntimeMessage::CommandRejected(rejection) => {
            panic!(
                "full project manifest import was rejected: {}",
                rejection.message
            )
        }
        _ => None,
    });
    session
        .submit_runtime(
            &RuntimeMessage::StateImportChunk(StateImportChunk {
                transfer_id,
                offset: 0,
                data: ProtocolBytes::new(encoded_manifest.clone()),
            }),
            None,
        )
        .unwrap();
    session
        .submit_runtime(
            &RuntimeMessage::StateImportCommit(StateImportCommit {
                transfer_id,
                digest: Some(ProtocolBytes::new(
                    blake3::hash(&encoded_manifest).as_bytes().to_vec(),
                )),
            }),
            None,
        )
        .unwrap();
    wait_for_runtime_event(session, |message, _| match message {
        RuntimeMessage::StateImportReady(ready) if ready.transfer_id == transfer_id => Some(()),
        RuntimeMessage::CommandRejected(rejection) => {
            panic!(
                "full project manifest commit was rejected: {}",
                rejection.message
            )
        }
        _ => None,
    });
}

fn prepare_full_project_export(session: &mut WebSession) -> StateTransferDescriptor {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        session
            .submit_runtime(
                &RuntimeMessage::StateExportRequest(StateExportRequest {
                    kind: StateExportKind::FullProjectFile,
                    snapshot_purpose: SnapshotExportPurpose::Normal,
                }),
                None,
            )
            .unwrap();
        let response = wait_for_runtime_event(session, |message, _| match message {
            RuntimeMessage::StateExportReady(ready) => match ready.result {
                StateExportResult::Ready { transfer } => Some(Some(transfer)),
                StateExportResult::Ineligible { reasons } => {
                    panic!("full project export was ineligible: {reasons:?}")
                }
            },
            RuntimeMessage::CommandRejected(_) => Some(None),
            _ => None,
        });
        if let Some(descriptor) = response {
            return descriptor;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "full project preparation did not finish"
        );
        std::thread::yield_now();
    }
}

fn read_project_file(session: &mut WebSession, descriptor: &StateTransferDescriptor) -> Vec<u8> {
    let total_bytes = usize::try_from(descriptor.total_bytes).unwrap();
    let mut bytes = Vec::with_capacity(total_bytes);
    while bytes.len() < total_bytes {
        let offset = bytes.len() as u64;
        let maximum_bytes =
            u32::try_from((descriptor.total_bytes - offset).min(64 * 1024)).unwrap();
        session
            .submit_runtime(
                &RuntimeMessage::StateExportChunkRequest(StateExportChunkRequest {
                    transfer_id: descriptor.transfer_id,
                    offset,
                    maximum_bytes,
                }),
                None,
            )
            .unwrap();
        let (chunk, complete) = wait_for_runtime_event(session, |message, data| match message {
            RuntimeMessage::StateExportChunk(chunk) if chunk.offset == offset => Some((
                data.expect("project file chunk should carry bulk bytes").0,
                chunk.complete,
            )),
            RuntimeMessage::CommandRejected(rejection) => {
                panic!("full project chunk was rejected: {}", rejection.message)
            }
            _ => None,
        });
        assert!(!chunk.is_empty());
        bytes.extend(chunk);
        assert_eq!(complete, bytes.len() == total_bytes);
    }
    assert_eq!(
        blake3::hash(&bytes).as_bytes(),
        descriptor.digest.as_slice()
    );
    bytes
}

fn wait_for_runtime_event<T>(
    session: &mut WebSession,
    mut select: impl FnMut(RuntimeMessage, Option<WebBytes>) -> Option<T>,
) -> T {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let batch = session.pump(RuntimeDriveBudget::default()).unwrap();
        for event in batch.events {
            if event.channel != WebChannel::Runtime {
                continue;
            }
            let message: RuntimeMessage = serde_json::from_value(event.message).unwrap();
            if let Some(value) = select(message, event.data_bytes) {
                return value;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for a runtime event"
        );
        std::thread::yield_now();
    }
}

fn batch(
    state: WebDriveState,
    vm_instructions: u64,
    runtime_transitions: u32,
    events: Vec<WebEvent>,
) -> PumpBatch {
    PumpBatch {
        state,
        vm_instructions,
        runtime_transitions,
        cooperative_background_work: false,
        events,
    }
}

fn test_event(message_type: &str) -> WebEvent {
    WebEvent {
        channel: WebChannel::Runtime,
        sequence: 1,
        message_id: 1,
        correlation_id: None,
        epoch: Some(1),
        message: serde_json::json!({ "type": message_type }),
        data_bytes: None,
    }
}

fn storage_event(request_id: u64) -> WebEvent {
    WebEvent {
        channel: WebChannel::Runtime,
        sequence: request_id,
        message_id: request_id,
        correlation_id: Some(request_id + 10),
        epoch: Some(1),
        message: serde_json::to_value(RuntimeMessage::StorageRequest(StorageRequest {
            request_id,
            namespace: era_runtime_protocol::StorageNamespace::Save,
            relative_path: format!("save{request_id:02}.sav"),
            operation: era_runtime_protocol::StorageOperation::Read,
            idempotency_key: String::new(),
            deadline_ns: None,
        }))
        .unwrap(),
        data_bytes: None,
    }
}

fn event_types(events: &[WebEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| event.message.get("type")?.as_str())
        .collect()
}

struct FakeNativePumpDriver {
    batches: VecDeque<Result<PumpBatch, String>>,
    submitted: Vec<NativeCompletion>,
    pump_calls: usize,
}

impl FakeNativePumpDriver {
    fn new(batches: impl IntoIterator<Item = PumpBatch>) -> Self {
        Self {
            batches: batches.into_iter().map(Ok).collect(),
            submitted: Vec::new(),
            pump_calls: 0,
        }
    }

    fn submitted_request_ids(&self) -> Vec<u64> {
        self.submitted
            .iter()
            .filter_map(|completion| match &completion.message {
                RuntimeMessage::StorageResponse(response) => Some(response.request_id),
                _ => None,
            })
            .collect()
    }
}

impl NativePumpDriver for FakeNativePumpDriver {
    fn pump_batch(&mut self) -> Result<PumpBatch, String> {
        self.pump_calls += 1;
        self.batches
            .pop_front()
            .unwrap_or_else(|| Err("unexpected extra native pump".to_owned()))
    }

    fn submit_completion(&mut self, completion: NativeCompletion) -> Result<(), String> {
        self.submitted.push(completion);
        Ok(())
    }
}

fn missing_storage_response(request: &StorageRequest) -> StorageResponse {
    StorageResponse {
        request_id: request.request_id,
        result: era_runtime_protocol::StorageResult::Error {
            error: era_runtime_protocol::FrontendIoError {
                kind: era_runtime_protocol::FrontendIoErrorKind::NotFound,
                message: "fixture".into(),
                platform_code: None,
            },
        },
    }
}
