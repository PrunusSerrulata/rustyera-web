use super::*;
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{FileCategory, FilePayload, StateExportChunk, SubmittedFile};
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
