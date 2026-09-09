use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{App, Manager, Runtime};

mod drive_clock;
mod native_evidence;
pub(crate) use drive_clock::{NativeDriveClock, NativeDriveTiming};
use native_evidence::{NativeEvidenceLedger, NativeEvidencePage};

const MAXIMUM_PUMP_SAMPLES: usize = 20_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativePumpTiming {
    epoch: u64,
    sequence: u64,
    operation: &'static str,
    request_decode_ms: f64,
    native_drive_ms: f64,
    native_setup_ms: f64,
    native_thread_cpu_ms: Option<f64>,
    json_serialize_ms: f64,
    response_bytes: usize,
    events: usize,
    /// Bounded attribution for large responses; never traverse or serialize event payloads.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    large_response_event_types: Vec<String>,
    vm_instructions: u64,
    runtime_transitions: u32,
}

#[derive(Default)]
struct TelemetryBuffer {
    epoch: u64,
    next_sequence: u64,
    dropped: u64,
    samples: VecDeque<NativePumpTiming>,
    core_client: Option<serde_json::Value>,
    setup_messages: Option<Vec<serde_json::Value>>,
    native_evidence: NativeEvidenceLedger,
}

#[derive(Clone, Default)]
pub(super) struct PerformanceAuditTelemetry {
    buffer: Arc<Mutex<TelemetryBuffer>>,
}

impl PerformanceAuditTelemetry {
    #[cfg(feature = "native-sql")]
    pub(super) fn record_native_completion(
        &self,
        completion: era_web_bridge::NativeCompletionEvidence,
    ) -> Result<(), String> {
        self.buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?
            .native_evidence
            .record(completion)
    }

    pub(super) fn capture_session_identity(
        &self,
        core_client: serde_json::Value,
        setup_messages: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?;
        buffer.core_client = Some(core_client);
        buffer.setup_messages = Some(setup_messages);
        Ok(())
    }

    pub(super) fn record(
        &self,
        operation: &'static str,
        request_decode_ms: f64,
        drive: NativeDriveTiming,
        json_serialize_ms: f64,
        response_bytes: usize,
        batch: &era_web_bridge::PumpBatch,
    ) {
        let Ok(mut buffer) = self.buffer.lock() else {
            return;
        };
        if buffer.samples.len() == MAXIMUM_PUMP_SAMPLES {
            buffer.samples.pop_front();
            buffer.dropped = buffer.dropped.saturating_add(1);
        }
        let sequence = buffer.next_sequence;
        buffer.next_sequence = buffer.next_sequence.saturating_add(1);
        let epoch = buffer.epoch;
        buffer.samples.push_back(NativePumpTiming {
            large_response_event_types: if response_bytes >= 1024 * 1024 {
                batch
                    .events
                    .iter()
                    .take(32)
                    .map(|event| {
                        event
                            .message
                            .get("type")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                            .chars()
                            .take(64)
                            .collect()
                    })
                    .collect()
            } else {
                Vec::new()
            },
            epoch,
            sequence,
            operation,
            request_decode_ms,
            native_drive_ms: drive.wall.as_secs_f64() * 1000.0,
            native_setup_ms: drive.setup.as_secs_f64() * 1000.0,
            native_thread_cpu_ms: drive.thread_cpu.map(|value| value.as_secs_f64() * 1000.0),
            json_serialize_ms,
            response_bytes,
            events: batch.events.len(),
            vm_instructions: batch.vm_instructions,
            runtime_transitions: batch.runtime_transitions,
        });
    }

    pub(super) fn reset(&self) -> Result<u64, String> {
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?;
        buffer.epoch = buffer.epoch.saturating_add(1);
        buffer.next_sequence = 0;
        buffer.dropped = 0;
        buffer.samples.clear();
        buffer.native_evidence = NativeEvidenceLedger::default();
        Ok(buffer.epoch)
    }

    pub(super) fn snapshot(&self) -> Result<NativeTelemetrySnapshot, String> {
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?;
        let epoch = buffer.epoch;
        let native_evidence = buffer.native_evidence.page(epoch, 0, false);
        Ok(NativeTelemetrySnapshot {
            evidence_only: false,
            native_evidence,
            schema_version: 2,
            epoch: buffer.epoch,
            next_sequence: buffer.next_sequence,
            dropped: buffer.dropped,
            remaining_samples: buffer.samples.len(),
            pumps: buffer.samples.iter().cloned().collect(),
            core_client: buffer.core_client.clone(),
            setup_messages: buffer.setup_messages.clone(),
        })
    }

    pub(super) fn take(
        &self,
        limit: usize,
        include_identity: bool,
    ) -> Result<NativeTelemetrySnapshot, String> {
        self.take_page(limit, include_identity, false)
    }

    /// Checkpoint-only drain: leaves every pump sample in the timing authority.
    pub(super) fn take_evidence(&self, limit: usize) -> Result<NativeTelemetrySnapshot, String> {
        self.take_page(limit, false, true)
    }

    fn take_page(
        &self,
        limit: usize,
        include_identity: bool,
        evidence_only: bool,
    ) -> Result<NativeTelemetrySnapshot, String> {
        if !(1..=1024).contains(&limit) {
            return Err("performance telemetry chunk limit must be between 1 and 1024".into());
        }
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?;
        if include_identity {
            let identity_bytes = serde_json::to_vec(&(&buffer.core_client, &buffer.setup_messages))
                .map_err(|error| error.to_string())?
                .len();
            if identity_bytes > 64 * 1024 {
                return Err("performance telemetry identity exceeds its page byte limit".into());
            }
        }
        let mut count = 0;
        let mut timing_bytes = 0;
        if !evidence_only {
            for sample in buffer.samples.iter().take(limit) {
                let bytes = serde_json::to_vec(sample)
                    .map_err(|error| error.to_string())?
                    .len()
                    + 1;
                if bytes > 128 * 1024 {
                    return Err(
                        "performance telemetry individual sample exceeds its page byte limit"
                            .into(),
                    );
                }
                if timing_bytes + bytes > 128 * 1024 {
                    break;
                }
                timing_bytes += bytes;
                count += 1;
            }
        }
        let pumps = buffer.samples.drain(..count).collect();
        let epoch = buffer.epoch;
        let native_evidence = buffer.native_evidence.page(epoch, limit, true);
        Ok(NativeTelemetrySnapshot {
            evidence_only,
            native_evidence,
            schema_version: 2,
            epoch: buffer.epoch,
            next_sequence: buffer.next_sequence,
            dropped: buffer.dropped,
            remaining_samples: buffer.samples.len(),
            pumps,
            core_client: include_identity
                .then(|| buffer.core_client.clone())
                .flatten(),
            setup_messages: include_identity
                .then(|| buffer.setup_messages.clone())
                .flatten(),
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeTelemetrySnapshot {
    evidence_only: bool,
    native_evidence: NativeEvidencePage,
    schema_version: u32,
    epoch: u64,
    next_sequence: u64,
    dropped: u64,
    remaining_samples: usize,
    pumps: Vec<NativePumpTiming>,
    core_client: Option<serde_json::Value>,
    setup_messages: Option<Vec<serde_json::Value>>,
}

pub(super) fn configure_window<R: Runtime>(
    app: &mut App<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("RUSTYERA_TAURI_PERF_AUDIT").as_deref() != Ok("1") {
        return Err("performance-audit build requires RUSTYERA_TAURI_PERF_AUDIT=1".into());
    }
    if cfg!(feature = "vm-instruction-profile")
        && std::env::var("RUSTYERA_TAURI_PERF_VM_SAMPLE").as_deref() != Ok("1")
    {
        return Err("instruction-profile build requires explicitly labelled VM sampling".into());
    }
    let mode = std::env::var("RUSTYERA_TAURI_PERF_WINDOW_MODE")?;
    let window = app
        .get_webview_window("main")
        .ok_or("performance audit main window is missing")?;
    match mode.as_str() {
        "visible" => {
            window.set_focusable(true)?;
            window.show()?;
            window.set_focus()?;
        }
        "minimized" => {
            // The test config creates the window hidden. Minimize before showing it so there is
            // never an on-screen, focusable transition frame.
            window.set_focusable(false)?;
            window.minimize()?;
            window.show()?;
        }
        _ => {
            return Err("performance audit window mode must be visible or minimized".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use era_web_bridge::{PumpBatch, WebDriveState};
    use std::time::Duration;

    use super::*;

    #[test]
    fn evidence_only_drain_preserves_pump_timing() {
        let telemetry = PerformanceAuditTelemetry::default();
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            immediate_work: false,
            vm_instructions: 0,
            runtime_transitions: 0,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        telemetry.record("pump", 0.0, NativeDriveTiming::default(), 0.0, 0, &batch);
        let evidence = telemetry.take_evidence(512).unwrap();
        assert!(evidence.evidence_only);
        assert!(evidence.pumps.is_empty());
        assert_eq!(evidence.remaining_samples, 1);
        let timing = telemetry.take(512, false).unwrap();
        assert!(!timing.evidence_only);
        assert_eq!(timing.pumps.len(), 1);
    }

    #[test]
    fn large_response_attribution_is_bounded_and_does_not_inspect_payloads() {
        let telemetry = PerformanceAuditTelemetry::default();
        let event = era_web_bridge::WebEvent {
            channel: era_web_bridge::WebChannel::Runtime,
            sequence: 1,
            message_id: 1,
            correlation_id: None,
            epoch: Some(1),
            message: serde_json::json!({"type": "界".repeat(65), "value": {"type": "ignored"}}),
            data_bytes: None,
        };
        let mut batch = PumpBatch {
            state: WebDriveState::OutputReady,
            immediate_work: false,
            vm_instructions: 0,
            runtime_transitions: 0,
            cooperative_background_work: false,
            events: vec![event; 33],
        };
        batch.events[1].message = serde_json::json!({"type": 1});
        batch.events[2].message = serde_json::json!({"value": {"type": "ignored"}});
        telemetry.record(
            "pump",
            0.0,
            NativeDriveTiming::default(),
            0.0,
            1024 * 1024 - 1,
            &batch,
        );
        telemetry.record(
            "pump",
            0.0,
            NativeDriveTiming::default(),
            0.0,
            1024 * 1024,
            &batch,
        );
        let snapshot = telemetry.snapshot().unwrap();
        assert!(snapshot.pumps[0].large_response_event_types.is_empty());
        let types = &snapshot.pumps[1].large_response_event_types;
        assert_eq!(types.len(), 32);
        assert_eq!(types[0], "界".repeat(64));
        assert_eq!(&types[1..3], ["unknown", "unknown"]);
    }

    #[test]
    fn reset_starts_a_new_epoch_and_clears_sequence_and_drops() {
        let telemetry = PerformanceAuditTelemetry::default();
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            immediate_work: false,
            vm_instructions: 7,
            runtime_transitions: 2,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        telemetry.record(
            "pump",
            0.0,
            NativeDriveTiming {
                wall: Duration::from_millis(1),
                ..NativeDriveTiming::default()
            },
            2.0,
            3,
            &batch,
        );
        assert_eq!(telemetry.snapshot().unwrap().next_sequence, 1);
        assert_eq!(telemetry.reset().unwrap(), 1);
        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.epoch, 1);
        assert_eq!(snapshot.next_sequence, 0);
        assert_eq!(snapshot.dropped, 0);
        assert!(snapshot.pumps.is_empty());
    }

    #[test]
    fn bounded_buffer_drops_the_oldest_sample_in_constant_time() {
        let telemetry = PerformanceAuditTelemetry::default();
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            immediate_work: false,
            vm_instructions: 0,
            runtime_transitions: 0,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        for _ in 0..=MAXIMUM_PUMP_SAMPLES {
            telemetry.record("pump", 0.0, NativeDriveTiming::default(), 0.0, 0, &batch);
        }
        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.pumps.len(), MAXIMUM_PUMP_SAMPLES);
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(snapshot.pumps[0].sequence, 1);
        let page = telemetry.take(1, false).unwrap();
        assert_eq!(page.dropped, 1);
        assert_eq!(
            page.next_sequence,
            u64::try_from(MAXIMUM_PUMP_SAMPLES).unwrap() + 1
        );
        assert_eq!(page.pumps[0].sequence, 1);
        assert_eq!(page.remaining_samples, MAXIMUM_PUMP_SAMPLES - 1);
    }

    #[test]
    fn reset_keeps_the_captured_session_identity() {
        let telemetry = PerformanceAuditTelemetry::default();
        let client = serde_json::json!({"features": ["graphics"], "capabilities": {}});
        telemetry
            .capture_session_identity(client.clone(), Vec::new())
            .unwrap();
        telemetry.reset().unwrap();
        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.core_client, Some(client));
        assert_eq!(snapshot.setup_messages, Some(Vec::new()));
    }

    #[test]
    fn chunk_take_preserves_epoch_sequence_and_drop_identity() {
        let telemetry = PerformanceAuditTelemetry::default();
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            immediate_work: false,
            vm_instructions: 7,
            runtime_transitions: 2,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        telemetry
            .capture_session_identity(serde_json::json!({"features": []}), Vec::new())
            .unwrap();
        telemetry.reset().unwrap();
        for _ in 0..3 {
            telemetry.record(
                "pump",
                1.0,
                NativeDriveTiming {
                    wall: Duration::from_millis(2),
                    setup: Duration::from_micros(250),
                    thread_cpu: Some(Duration::from_micros(1500)),
                },
                3.0,
                4,
                &batch,
            );
        }
        let first = telemetry.take(2, true).unwrap();
        assert_eq!(first.epoch, 1);
        assert_eq!(first.next_sequence, 3);
        assert_eq!(first.remaining_samples, 1);
        assert_eq!(first.dropped, 0);
        let serialized = serde_json::to_value(&first.pumps[0]).unwrap();
        assert_eq!(serialized["nativeDriveMs"], 2.0);
        assert_eq!(serialized["nativeSetupMs"], 0.25);
        assert_eq!(serialized["nativeThreadCpuMs"], 1.5);
        assert_eq!(
            first
                .pumps
                .iter()
                .map(|sample| sample.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert!(first.core_client.is_some());
        let second = telemetry.take(2, false).unwrap();
        assert_eq!(second.pumps[0].sequence, 2);
        assert_eq!(second.remaining_samples, 0);
        assert_eq!(second.next_sequence, 3);
        assert!(second.core_client.is_none());
        assert!(telemetry.take(2, false).unwrap().pumps.is_empty());
        telemetry.record("pump", 0.0, NativeDriveTiming::default(), 0.0, 0, &batch);
        assert_eq!(telemetry.take(2, false).unwrap().pumps[0].sequence, 3);
        assert!(telemetry.take(0, false).is_err());
        assert!(telemetry.take(1025, false).is_err());
    }
}
