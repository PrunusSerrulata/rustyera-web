use super::*;
use era_protocol::VersionRange;
use era_runtime_protocol::ServiceKind;

// Keep the pre-r35 closure contract cases exercising the unified implementation.
fn extract_native_events(
    events: Vec<WebEvent>,
    allowance: usize,
    storage: impl FnMut(StorageRequest) -> StorageResponse,
    service: impl FnMut(ServiceRequest) -> Option<ServiceResponse>,
) -> Result<(Vec<WebEvent>, Vec<NativeCompletion>), String> {
    let mut driver = FakeNativePumpDriver::new([]);
    let visible = process_native_events(
        events,
        &mut driver,
        &mut VecDeque::new(),
        &mut ClosureNativeHost { storage, service },
        &mut 0,
        allowance,
        &mut || false,
    )?;
    Ok((visible, driver.submitted))
}

fn drive_native_until_blocked(
    driver: &mut impl NativePumpDriver,
    maximum_batches: usize,
    maximum_external_requests: usize,
    storage: impl FnMut(StorageRequest) -> StorageResponse,
    service: impl FnMut(ServiceRequest) -> Option<ServiceResponse>,
) -> Result<PumpBatch, String> {
    drive_native_handler(
        driver,
        &mut VecDeque::new(),
        NativePumpLimits {
            maximum_quiet_slices: 1,
            maximum_batches,
            maximum_external_requests,
            until_blocked: true,
        },
        &mut ClosureNativeHost { storage, service },
        &mut || false,
    )
}

#[derive(Default)]
struct OwnedNativeHost {
    calls: Vec<u64>,
    lifecycles: Vec<(SqlProviderHandleV1, Option<SqlProviderHandleV1>)>,
    expire_after_service: Option<std::rc::Rc<std::cell::Cell<bool>>>,
    expire_after_sync: Option<std::rc::Rc<std::cell::Cell<bool>>>,
    #[cfg(feature = "performance-audit")]
    completions: Vec<NativeCompletionEvidence>,
    #[cfg(feature = "performance-audit")]
    audit_failure: bool,
}

impl NativeHostHandler for OwnedNativeHost {
    fn handle_storage(&mut self, request: StorageRequest) -> StorageResponse {
        self.calls.push(request.request_id);
        missing_storage_response(&request)
    }

    fn handle_service(&mut self, request: ServiceRequest) -> Option<ServiceResponse> {
        self.calls.push(request.request_id);
        if let Some(expired) = &self.expire_after_service {
            expired.set(true);
        }
        Some(ServiceResponse {
            request_id: request.request_id,
            result: era_runtime_protocol::ServiceResult::Ready {
                payload: ProtocolBytes::default(),
            },
        })
    }

    fn owns_service(&self, request: &ServiceRequest) -> bool {
        request.kind == ServiceKind::Sql
    }

    fn sync_sql_providers(
        &mut self,
        live: SqlProviderHandleV1,
        candidate: Option<SqlProviderHandleV1>,
    ) -> Result<(), String> {
        self.lifecycles.push((live, candidate));
        if let Some(expired) = &self.expire_after_sync {
            expired.set(true);
        }
        Ok(())
    }

    #[cfg(feature = "performance-audit")]
    fn record_completion(&mut self, completion: NativeCompletionEvidence) -> Result<(), String> {
        self.completions.push(completion);
        if self.audit_failure {
            return Err("sticky capture invalid".into());
        }
        Ok(())
    }
}

fn owned_service_event(id: u64) -> WebEvent {
    let mut event = storage_event(id);
    event.message = serde_json::to_value(RuntimeMessage::ServiceRequest(ServiceRequest {
        request_id: id,
        kind: ServiceKind::Sql,
        operation: era_runtime_protocol::SQL_OPERATION.into(),
        operation_version: era_runtime_protocol::SQL_OPERATION_VERSION,
        payload: ProtocolBytes::default(),
        deadline_ns: None,
    }))
    .unwrap();
    event
}

fn native_limits(external: usize) -> NativePumpLimits {
    NativePumpLimits {
        maximum_quiet_slices: 1,
        maximum_batches: 16,
        maximum_external_requests: external,
        until_blocked: true,
    }
}

#[test]
fn deferred_owned_requests_preserve_terminal_state_on_resume() {
    for state in [WebDriveState::Stopped, WebDriveState::Faulted] {
        let mut driver =
            FakeNativePumpDriver::new([batch(state, 1, 1, vec![owned_service_event(1)])]);
        let mut host = OwnedNativeHost::default();
        let mut pending = VecDeque::new();
        let initial = drive_native_handler(
            &mut driver,
            &mut pending,
            native_limits(0),
            &mut host,
            &mut || false,
        )
        .unwrap();
        assert_eq!(initial.state, state);
        assert!(!initial.immediate_work);
        let resumed = drive_native_handler(
            &mut driver,
            &mut pending,
            native_limits(1),
            &mut host,
            &mut || false,
        )
        .unwrap();
        assert_eq!(resumed.state, state);
        assert!(!resumed.immediate_work);
        assert!(pending.is_empty());
        assert_eq!(host.calls, [1]);
        assert_eq!(driver.pump_calls, 1);
    }
}

#[test]
fn unified_native_owner_handles_storage_and_service_with_one_mutable_borrow() {
    let mut driver = FakeNativePumpDriver::new([
        batch(
            WebDriveState::OutputReady,
            1,
            1,
            vec![storage_event(1), owned_service_event(2)],
        ),
        batch(WebDriveState::Idle, 1, 1, vec![]),
    ]);
    let mut host = OwnedNativeHost::default();
    let result = drive_native_handler(
        &mut driver,
        &mut VecDeque::new(),
        native_limits(8),
        &mut host,
        &mut || false,
    )
    .unwrap();
    assert_eq!(host.calls, [1, 2]);
    assert_eq!(host.lifecycles.len(), 2);
    assert_eq!(result.state, WebDriveState::Idle);
    assert!(!result.immediate_work);
    assert!(result.events.is_empty());
}

#[test]
fn owned_services_stay_pending_at_zero_and_exact_caps_and_resume_in_order() {
    for allowance in [0, 1] {
        let mut driver = FakeNativePumpDriver::new([
            batch(
                WebDriveState::OutputReady,
                1,
                1,
                vec![
                    test_event("before"),
                    owned_service_event(1),
                    test_event("middle"),
                    owned_service_event(2),
                    test_event("after"),
                ],
            ),
            batch(WebDriveState::Idle, 1, 1, vec![]),
        ]);
        let mut host = OwnedNativeHost::default();
        let mut pending = VecDeque::new();
        let result = drive_native_handler(
            &mut driver,
            &mut pending,
            native_limits(allowance),
            &mut host,
            &mut || false,
        )
        .unwrap();
        assert_eq!(host.calls.len(), allowance);
        assert_eq!(pending.len(), 2 - allowance);
        assert_eq!(event_types(&result.events), ["before", "middle", "after"]);
        assert_eq!(result.state, WebDriveState::MoreWork);
        assert!(result.immediate_work);
        assert_eq!(driver.pump_calls, 1);
        let resumed = drive_native_handler(
            &mut driver,
            &mut pending,
            native_limits(8),
            &mut host,
            &mut || false,
        )
        .unwrap();
        assert_eq!(host.calls, [1, 2]);
        assert!(pending.is_empty());
        assert_eq!(resumed.state, WebDriveState::Idle);
        assert!(!resumed.immediate_work);
        #[cfg(feature = "performance-audit")]
        {
            assert_eq!(host.completions.len(), 2);
            for (index, completion) in host.completions.iter().enumerate() {
                assert_eq!(
                    serde_json::to_value(&completion.request.message).unwrap(),
                    owned_service_event(index as u64 + 1).message
                );
                assert_eq!(completion.response_message_id, 1001 + index as u64);
            }
        }
    }
}

#[test]
fn owned_service_deadline_yields_after_completion_without_cancelling_or_leaking() {
    let expired = std::rc::Rc::new(std::cell::Cell::new(false));
    let mut host = OwnedNativeHost {
        expire_after_service: Some(expired.clone()),
        ..OwnedNativeHost::default()
    };
    let mut driver = FakeNativePumpDriver::new([
        batch(
            WebDriveState::OutputReady,
            1,
            1,
            vec![
                owned_service_event(1),
                test_event("middle"),
                owned_service_event(2),
            ],
        ),
        batch(WebDriveState::Idle, 1, 1, vec![]),
    ]);
    let mut pending = VecDeque::new();
    let result = drive_native_handler(
        &mut driver,
        &mut pending,
        native_limits(8),
        &mut host,
        &mut || expired.get(),
    )
    .unwrap();
    assert_eq!(host.calls, [1]);
    assert_eq!(driver.submitted.len(), 1);
    assert_eq!(pending.len(), 1);
    assert_eq!(event_types(&result.events), ["middle"]);
    assert_eq!(result.state, WebDriveState::MoreWork);
    assert!(result.immediate_work);
    assert_eq!(driver.pump_calls, 1);
    host.expire_after_service = None;
    expired.set(false);
    let resumed = drive_native_handler(
        &mut driver,
        &mut pending,
        native_limits(8),
        &mut host,
        &mut || expired.get(),
    )
    .unwrap();
    assert_eq!(host.calls, [1, 2]);
    assert!(pending.is_empty());
    assert_eq!(resumed.state, WebDriveState::Idle);
}

#[test]
fn lifecycle_sync_runs_after_every_actual_quiet_drive_without_sql_requests() {
    let mut driver = FakeNativePumpDriver::new([
        batch(WebDriveState::MoreWork, 1, 1, vec![]),
        batch(WebDriveState::MoreWork, 1, 1, vec![]),
        batch(WebDriveState::Idle, 1, 1, vec![]),
    ]);
    let mut host = OwnedNativeHost::default();
    let mut limits = native_limits(8);
    limits.maximum_quiet_slices = 16;
    let result = drive_native_handler(
        &mut driver,
        &mut VecDeque::new(),
        limits,
        &mut host,
        &mut || false,
    )
    .unwrap();
    assert_eq!(
        host.lifecycles
            .iter()
            .map(|(live, _)| live.id)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(result.state, WebDriveState::Idle);
    assert_eq!(driver.pump_calls, 3);
    assert_eq!(host.lifecycles[0].1, None);
    assert_eq!(
        host.lifecycles[1].1,
        Some(SqlProviderHandleV1 {
            service_epoch: 2,
            id: 99
        })
    );
    assert_eq!(host.lifecycles[2].1, None);
}

#[test]
fn quiet_deadline_stops_before_the_next_actual_drive() {
    let expired = std::rc::Rc::new(std::cell::Cell::new(false));
    let mut host = OwnedNativeHost {
        expire_after_sync: Some(expired.clone()),
        ..OwnedNativeHost::default()
    };
    let mut driver = FakeNativePumpDriver::new([batch(WebDriveState::MoreWork, 7, 1, vec![])]);
    let mut limits = native_limits(8);
    limits.maximum_quiet_slices = 16;
    let result = drive_native_handler(
        &mut driver,
        &mut VecDeque::new(),
        limits,
        &mut host,
        &mut || expired.get(),
    )
    .unwrap();
    assert_eq!(driver.pump_calls, 1);
    assert_eq!(result.vm_instructions, 7);
    assert_eq!(result.state, WebDriveState::MoreWork);
    assert!(result.immediate_work);
}

#[test]
fn public_native_handler_uses_the_actual_runtime_lifecycle() {
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    let mut host = OwnedNativeHost::default();
    session
        .pump_with_native_handler(RuntimeDriveBudget::default(), 1, 8, &mut host)
        .unwrap();
    assert!(session.is_negotiated());
    assert_eq!(
        host.lifecycles.last().copied(),
        Some(session.runtime.sql_provider_lifecycle())
    );
    session
        .pump_with_native_handler_until_blocked(RuntimeDriveBudget::default(), 1, 1, 8, &mut host)
        .unwrap();
    assert_eq!(host.lifecycles.len(), 2);
}

#[test]
fn pending_owned_queue_is_bounded_and_zero_allowance_never_drives_again() {
    let events = (0..MAXIMUM_PENDING_NATIVE_REQUESTS as u64)
        .map(owned_service_event)
        .collect();
    let mut driver = FakeNativePumpDriver::new([batch(WebDriveState::OutputReady, 1, 1, events)]);
    let mut host = OwnedNativeHost::default();
    let mut pending = VecDeque::new();
    drive_native_handler(
        &mut driver,
        &mut pending,
        native_limits(0),
        &mut host,
        &mut || false,
    )
    .unwrap();
    let result = drive_native_handler(
        &mut driver,
        &mut pending,
        native_limits(0),
        &mut host,
        &mut || false,
    )
    .unwrap();
    assert_eq!(pending.len(), MAXIMUM_PENDING_NATIVE_REQUESTS);
    assert_eq!(driver.pump_calls, 1);
    assert!(host.calls.is_empty());
    assert!(result.events.is_empty());
    assert!(result.immediate_work);
}

#[cfg(feature = "performance-audit")]
#[test]
fn audit_completion_preserves_original_envelope_and_actual_submit_id() {
    let mut session = negotiated_web_session();
    let expected_id = session.next_message_id;
    let request = owned_service_event(71);
    let expected_request = serde_json::to_value(&request).unwrap();
    let mut host = OwnedNativeHost::default();
    let response = RuntimeMessage::ServiceResponse(ServiceResponse {
        request_id: 71,
        result: era_runtime_protocol::ServiceResult::Ready {
            payload: ProtocolBytes::default(),
        },
    });
    submit_native_completion(
        &mut WebSessionNativePumpDriver {
            session: &mut session,
            budget: RuntimeDriveBudget::default(),
        },
        &mut host,
        NativeCompletion {
            message: response.clone(),
            correlation_id: request.correlation_id,
            evidence: NativeRequestEvidence::new(
                &request,
                RuntimeMessage::deserialize(&request.message).unwrap(),
            ),
        },
    )
    .unwrap();
    assert_eq!(session.next_message_id, expected_id + 1);
    assert_eq!(host.completions.len(), 1);
    let completion = &host.completions[0];
    assert_eq!(
        serde_json::to_value(&completion.request.message).unwrap(),
        expected_request["message"]
    );
    assert_eq!(
        completion.request.message_id,
        expected_request["messageId"].as_u64().unwrap()
    );
    assert_eq!(
        completion.request.sequence,
        expected_request["sequence"].as_u64().unwrap()
    );
    assert_eq!(
        serde_json::to_value(&completion.response).unwrap(),
        serde_json::to_value(response).unwrap()
    );
    assert_eq!(completion.response_message_id, expected_id);
}

#[cfg(feature = "performance-audit")]
#[test]
fn post_submit_audit_failure_preserves_completed_batch_without_retrying_write() {
    let mut driver = FakeNativePumpDriver::new([
        batch(
            WebDriveState::OutputReady,
            1,
            1,
            vec![test_event("before"), storage_event(1), test_event("after")],
        ),
        batch(WebDriveState::Idle, 1, 1, vec![]),
    ]);
    let mut host = OwnedNativeHost {
        audit_failure: true,
        ..OwnedNativeHost::default()
    };
    let result = drive_native_handler(
        &mut driver,
        &mut VecDeque::new(),
        native_limits(8),
        &mut host,
        &mut || false,
    )
    .unwrap();
    assert_eq!(event_types(&result.events), ["before", "after"]);
    assert_eq!(result.state, WebDriveState::Idle);
    assert_eq!(host.calls, [1]);
    assert_eq!(host.completions.len(), 1);
    assert!(host.audit_failure);
}

#[cfg(feature = "performance-audit")]
#[test]
fn audit_callback_is_not_called_when_actual_submit_fails() {
    let mut session = negotiated_web_session();
    session.wire_limits.maximum_envelope_bytes = 1;
    let mut host = OwnedNativeHost::default();
    let result = submit_native_completion(
        &mut WebSessionNativePumpDriver {
            session: &mut session,
            budget: RuntimeDriveBudget::default(),
        },
        &mut host,
        NativeCompletion {
            message: RuntimeMessage::StorageResponse(missing_storage_response(&StorageRequest {
                request_id: 1,
                namespace: era_runtime_protocol::StorageNamespace::Save,
                relative_path: "fixture".into(),
                operation: era_runtime_protocol::StorageOperation::Read,
                idempotency_key: String::new(),
                deadline_ns: None,
            })),
            correlation_id: Some(11),
            evidence: NativeRequestEvidence::new(
                &storage_event(1),
                RuntimeMessage::deserialize(&storage_event(1).message).unwrap(),
            ),
        },
    );
    assert!(result.is_err());
    assert!(host.completions.is_empty());
}

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
    let sql = hello
        .capabilities
        .services
        .iter()
        .find(|capability| {
            capability.kind == ServiceKind::Sql
                && capability.operation == era_runtime_protocol::SQL_OPERATION
        })
        .expect("SQL service capability");
    assert_eq!(sql.versions, era_runtime_protocol::SQL_OPERATION_VERSIONS);
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
    assert!(!saturated.immediate_work);
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
    assert!(combined.immediate_work);
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
    assert!(!combined.immediate_work);
}

#[test]
fn bounded_native_driver_marks_queued_completion_at_batch_cap() {
    let mut driver = FakeNativePumpDriver::new([batch(
        WebDriveState::OutputReady,
        1,
        1,
        vec![storage_event(1)],
    )]);
    let result = drive_native_until_blocked(
        &mut driver,
        1,
        16,
        |request| missing_storage_response(&request),
        |_| None,
    )
    .unwrap();
    assert_eq!(result.state, WebDriveState::MoreWork);
    assert!(result.immediate_work);
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
    assert!(combined.immediate_work);
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
            assert!(!combined.immediate_work, "trigger={trigger}");
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
