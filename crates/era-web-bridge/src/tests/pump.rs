use super::*;
use era_protocol::VersionRange;
use era_runtime_protocol::ServiceKind;

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
        WebSessionOptions {
            audio_available: true,
            ..WebSessionOptions::default()
        },
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
    for (kind, operation, major) in [
        (ServiceKind::InputState, "device_pump", 1),
        (ServiceKind::InputState, "pointer_state", 1),
        (ServiceKind::Canvas, "sample_canvas_pixel", 1),
        (
            ServiceKind::PresentationQuery,
            era_runtime_protocol::GET_LINE_GEOMETRY_OPERATION,
            1,
        ),
        (ServiceKind::Sql, era_runtime_protocol::SQL_OPERATION, 1),
        (
            ServiceKind::Audio,
            era_runtime_protocol::AUDIO_OBSERVATION_OPERATION,
            1,
        ),
        (ServiceKind::PresentationQuery, "html_string_len", 2),
        (ServiceKind::PresentationQuery, "html_substring", 2),
        (ServiceKind::PresentationQuery, "html_string_lines", 2),
    ] {
        let matched = hello
            .capabilities
            .services
            .iter()
            .filter(|capability| capability.kind == kind && capability.operation == operation)
            .collect::<Vec<_>>();
        assert_eq!(matched.len(), 1, "{operation}");
        assert_eq!(
            matched[0].versions,
            VersionRange::exact(era_protocol::ProtocolVersion::new(major, 0))
        );
    }
    assert!(
        !hello
            .capabilities
            .services
            .iter()
            .any(|capability| capability.operation == "html_pixel_size")
    );
    let environment = hello
        .capabilities
        .environment
        .iter()
        .map(|capability| capability.name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        environment,
        [
            era_runtime_protocol::INPUT_DEVICE_LATCH_CAPABILITY,
            era_runtime_protocol::INPUT_DEVICE_PUMP_CAPABILITY,
            era_runtime_protocol::INPUT_TIMED_VIEWPORT_CAPABILITY,
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn client_omits_audio_observation_without_a_ready_provider() {
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
    assert!(!hello.capabilities.audio);
    assert!(!hello.capabilities.services.iter().any(|capability| {
        capability.kind == ServiceKind::Audio
            && capability.operation == era_runtime_protocol::AUDIO_OBSERVATION_OPERATION
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
