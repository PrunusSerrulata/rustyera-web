use super::*;
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FileCategory, FilePayload, SnapshotExportPurpose, StateExportChunk, StateExportChunkRequest,
    StateExportKind, StateExportRequest, StateExportResult, StateImportBegin, StateImportChunk,
    StateImportCommit, StateTransferDescriptor, SubmittedFile,
};
use std::collections::VecDeque;

mod project;
mod pump;

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
