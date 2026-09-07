use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{App, Manager, PhysicalPosition, Runtime};

const MAXIMUM_PUMP_SAMPLES: usize = 20_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativePumpTiming {
    epoch: u64,
    sequence: u64,
    operation: &'static str,
    request_decode_ms: f64,
    native_drive_ms: f64,
    json_serialize_ms: f64,
    response_bytes: usize,
    events: usize,
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
}

#[derive(Clone, Default)]
pub(super) struct PerformanceAuditTelemetry {
    buffer: Arc<Mutex<TelemetryBuffer>>,
}

impl PerformanceAuditTelemetry {
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
        native_drive_ms: f64,
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
            epoch,
            sequence,
            operation,
            request_decode_ms,
            native_drive_ms,
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
        Ok(buffer.epoch)
    }

    pub(super) fn snapshot(&self) -> Result<NativeTelemetrySnapshot, String> {
        let buffer = self
            .buffer
            .lock()
            .map_err(|error| format!("performance telemetry lock was poisoned: {error}"))?;
        Ok(NativeTelemetrySnapshot {
            schema_version: 2,
            epoch: buffer.epoch,
            next_sequence: buffer.next_sequence,
            dropped: buffer.dropped,
            pumps: buffer.samples.iter().cloned().collect(),
            core_client: buffer.core_client.clone(),
            setup_messages: buffer.setup_messages.clone(),
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeTelemetrySnapshot {
    schema_version: u32,
    epoch: u64,
    next_sequence: u64,
    dropped: u64,
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
        "offscreen" => {
            window.set_focusable(false)?;
            let monitors = window.available_monitors()?;
            let right = monitors
                .iter()
                .map(|monitor| i64::from(monitor.position().x) + i64::from(monitor.size().width))
                .max()
                .ok_or("performance audit requires at least one monitor")?;
            let bottom = monitors
                .iter()
                .map(|monitor| i64::from(monitor.position().y) + i64::from(monitor.size().height))
                .max()
                .ok_or("performance audit requires at least one monitor")?;
            let x = i32::try_from(right.saturating_add(2_048))?;
            let y = i32::try_from(bottom.saturating_add(2_048))?;
            window.set_position(PhysicalPosition::new(x, y))?;
            window.show()?;
        }
        _ => {
            return Err(
                "performance audit window mode must be visible, minimized, or offscreen".into(),
            );
        }
    }
    if mode != "visible" && window.is_focused()? {
        return Err("performance audit window unexpectedly acquired focus".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use era_web_bridge::{PumpBatch, WebDriveState};

    use super::*;

    #[test]
    fn reset_starts_a_new_epoch_and_clears_sequence_and_drops() {
        let telemetry = PerformanceAuditTelemetry::default();
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            vm_instructions: 7,
            runtime_transitions: 2,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        telemetry.record("pump", 0.0, 1.0, 2.0, 3, &batch);
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
            vm_instructions: 0,
            runtime_transitions: 0,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        for _ in 0..=MAXIMUM_PUMP_SAMPLES {
            telemetry.record("pump", 0.0, 0.0, 0.0, 0, &batch);
        }
        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.pumps.len(), MAXIMUM_PUMP_SAMPLES);
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(snapshot.pumps[0].sequence, 1);
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
}
