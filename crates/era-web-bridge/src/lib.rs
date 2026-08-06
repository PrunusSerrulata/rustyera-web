//! Shared checked session bridge for the Tauri and WebAssembly frontends.
//!
//! The bridge deliberately exposes serde projections rather than duplicating the
//! integer-keyed CBOR contract in TypeScript. Both web hosts still exercise the
//! exact same versioned runtime and debug envelopes as the C ABI frontend.

use era_debug_protocol::{DEBUG_PROTOCOL_VERSION, DebugMessage, DebugScope};
use era_protocol::{
    Channel, SessionEpoch, SessionId, VersionRange, WireLimits, decode_envelope, encode_envelope,
};
use era_runtime::{
    ProjectProgressReporter, RuntimeDriveBudget, RuntimeDriveState, RuntimeOptions, RuntimeSession,
};
use era_runtime_protocol::{
    ClientCapabilities, ClientHello, ConfigurationClientProfile, InputModality, ProjectIdentity,
    ProjectLoadRequest, ProjectManifest, RUNTIME_PROTOCOL_VERSION, RuntimeFeature, RuntimeLimits,
    RuntimeMessage, SequenceAcknowledgement, ServerHello, ServiceCapability, ServiceKind,
    StateExportKind, StateImportBegin, StateImportChunk, StateImportCommit, StorageCapabilities,
};
use erabasic_vm::VmConfig;
use serde::{Deserialize, Serialize};

const DEFAULT_ENVELOPE_BYTES: u64 = 512 * 1024 * 1024;
const DEBUG_SCOPE_ALL: u64 = (1 << 10) - 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionOptions {
    #[serde(default = "default_client_name")]
    pub client_name: String,
    #[serde(default)]
    pub available_fonts: Vec<String>,
    #[serde(default = "default_locales")]
    pub preferred_locales: Vec<String>,
    #[serde(default = "default_true")]
    pub audio_available: bool,
    #[serde(default = "default_debug_scope_mask")]
    pub debug_scope_mask: u64,
    #[serde(default = "default_envelope_bytes")]
    pub maximum_envelope_bytes: u64,
    #[serde(default = "default_configuration_profile")]
    pub configuration_profile: ConfigurationClientProfile,
}

impl Default for WebSessionOptions {
    fn default() -> Self {
        Self {
            client_name: default_client_name(),
            available_fonts: Vec::new(),
            preferred_locales: default_locales(),
            audio_available: true,
            debug_scope_mask: default_debug_scope_mask(),
            maximum_envelope_bytes: DEFAULT_ENVELOPE_BYTES,
            configuration_profile: default_configuration_profile(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebChannel {
    Runtime,
    Debug,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebEvent {
    pub channel: WebChannel,
    pub sequence: u64,
    pub message_id: u64,
    pub correlation_id: Option<u64>,
    pub epoch: Option<u64>,
    pub message: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpBatch {
    pub state: WebDriveState,
    pub vm_instructions: u64,
    pub runtime_transitions: u32,
    pub events: Vec<WebEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTraditionalSaveInspection {
    pub description: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebDriveState {
    Idle,
    MoreWork,
    OutputReady,
    Stopped,
    Faulted,
}

/// A single-owner runtime session with frontend sequence and identity bookkeeping.
pub struct WebSession {
    runtime: RuntimeSession,
    wire_limits: WireLimits,
    session: Option<SessionId>,
    epoch: Option<SessionEpoch>,
    runtime_sequence: u64,
    debug_sequence: u64,
    next_message_id: u64,
}

impl WebSession {
    /// Create a negotiated graphics/audio-capable web session.
    ///
    /// # Errors
    ///
    /// Returns an error if the initial `ClientHello` cannot be encoded or queued.
    pub fn new(options: WebSessionOptions) -> Result<Self, String> {
        let maximum_envelope_bytes = options.maximum_envelope_bytes.max(1024 * 1024);
        let maximum_payload_bytes = maximum_envelope_bytes.saturating_sub(1024 * 1024).max(1024);
        let limits = RuntimeLimits {
            maximum_envelope_bytes,
            maximum_payload_bytes,
            maximum_pending_requests: 128,
            maximum_journal_entries: 4096,
            maximum_drive_instructions: 1_000_000,
            maximum_transfer_bytes: maximum_payload_bytes,
        };
        let wire_limits = WireLimits {
            maximum_envelope_bytes: usize::try_from(maximum_envelope_bytes)
                .map_err(|_| "maximum envelope size is not supported on this platform")?,
            maximum_payload_bytes: usize::try_from(maximum_payload_bytes)
                .map_err(|_| "maximum payload size is not supported on this platform")?,
        };
        let runtime = RuntimeSession::new(RuntimeOptions {
            session_id: SessionId { high: 0, low: 1 },
            limits,
            wire_limits,
            vm_config: VmConfig::default(),
            debug_scope_mask: options.debug_scope_mask,
        });
        let mut session = Self {
            runtime,
            wire_limits,
            session: None,
            epoch: None,
            runtime_sequence: 0,
            debug_sequence: 0,
            next_message_id: 1,
        };
        session.submit_runtime(
            &RuntimeMessage::ClientHello(client_hello(options, limits)),
            None,
        )?;
        Ok(session)
    }

    /// Install or clear the host's read-only project workload observer.
    pub fn set_project_progress_reporter(&mut self, reporter: Option<ProjectProgressReporter>) {
        self.runtime.set_project_progress_reporter(reporter);
    }

    /// Submit any public runtime message through a checked envelope.
    ///
    /// # Errors
    ///
    /// Returns an error for encoding, sequence, session, or runtime validation failures.
    pub fn submit_runtime(
        &mut self,
        message: &RuntimeMessage,
        correlation_id: Option<u64>,
    ) -> Result<u64, String> {
        let message_id = self.take_message_id();
        let envelope = message
            .envelope(
                self.session,
                self.epoch,
                self.runtime_sequence,
                message_id,
                correlation_id,
            )
            .map_err(|error| error.to_string())?;
        let bytes =
            encode_envelope(&envelope, self.wire_limits).map_err(|error| error.to_string())?;
        self.runtime
            .submit_envelope(&bytes)
            .map_err(|error| error.to_string())?;
        self.runtime_sequence = self.runtime_sequence.saturating_add(1);
        Ok(message_id)
    }

    /// Submit any public debugger message through the independent debug channel.
    ///
    /// # Errors
    ///
    /// Returns an error until negotiation completes or when validation fails.
    pub fn submit_debug(
        &mut self,
        message: &DebugMessage,
        correlation_id: Option<u64>,
    ) -> Result<u64, String> {
        if self.session.is_none() || self.epoch.is_none() {
            return Err("debug protocol requires a negotiated runtime session".into());
        }
        let message_id = self.take_message_id();
        let envelope = message
            .envelope(
                self.session,
                self.epoch,
                self.debug_sequence,
                message_id,
                correlation_id,
            )
            .map_err(|error| error.to_string())?;
        let bytes =
            encode_envelope(&envelope, self.wire_limits).map_err(|error| error.to_string())?;
        self.runtime
            .submit_envelope(&bytes)
            .map_err(|error| error.to_string())?;
        self.debug_sequence = self.debug_sequence.saturating_add(1);
        Ok(message_id)
    }

    /// Submit a project and its deterministic identity.
    ///
    /// # Errors
    ///
    /// Returns an error if an input digest is malformed or the request cannot be queued.
    pub fn load_project(&mut self, manifest: ProjectManifest) -> Result<u64, String> {
        let identity = project_identity(&manifest)?;
        self.load_project_request(identity, Some(manifest), None)
    }

    /// Decode and validate the manifest embedded in a self-contained project file.
    ///
    /// # Errors
    ///
    /// Returns an error when the project file is corrupt, unsupported, or exceeds its own
    /// transfer size.
    pub fn project_file_manifest(&self, bytes: &[u8]) -> Result<ProjectManifest, String> {
        era_runtime::decode_project_file_frontend_manifest(bytes, bytes.len())
            .map(|decoded| decoded.manifest)
            .map_err(|error| error.to_string())
    }

    /// Return the active project's traditional-save slot count.
    ///
    /// # Errors
    ///
    /// Returns an error until a project has compiled successfully.
    pub fn traditional_save_slot_count(&self) -> Result<u32, String> {
        self.runtime
            .traditional_save_slot_count()
            .ok_or_else(|| "no compiled project is available".to_owned())
    }

    /// Validate a traditional save against the active project without changing runtime state.
    ///
    /// # Errors
    ///
    /// Returns an error when the save is malformed or incompatible with the active project.
    pub fn inspect_traditional_save(
        &self,
        bytes: &[u8],
    ) -> Result<WebTraditionalSaveInspection, String> {
        let inspection = self
            .runtime
            .inspect_traditional_save(bytes)
            .map_err(|error| error.to_string())?;
        Ok(WebTraditionalSaveInspection {
            description: inspection.description,
        })
    }

    /// Import a compiled cache without copying the opaque payload through JavaScript.
    ///
    /// # Errors
    ///
    /// Returns an error if the state transfer is rejected or cannot be completed.
    pub fn load_project_with_compiled_cache(
        &mut self,
        identity: ProjectIdentity,
        cache: &[u8],
    ) -> Result<u64, String> {
        let begin_message = self.submit_runtime(
            &RuntimeMessage::StateImportBegin(StateImportBegin {
                kind: StateExportKind::CompiledProjectCache,
                total_bytes: u64::try_from(cache.len())
                    .map_err(|_| "compiled cache is too large".to_owned())?,
                digest: era_protocol::ProtocolBytes::new(blake3::hash(cache).as_bytes().to_vec()),
                artifact_id: None,
            }),
            None,
        )?;
        let transfer_id = self.wait_for_transfer_event(
            "state_import_accepted",
            begin_message,
            "compiled cache import was not accepted",
        )?;
        for (index, chunk) in cache.chunks(1024 * 1024).enumerate() {
            self.submit_runtime(
                &RuntimeMessage::StateImportChunk(StateImportChunk {
                    transfer_id,
                    offset: u64::try_from(index * 1024 * 1024)
                        .map_err(|_| "compiled cache offset overflowed".to_owned())?,
                    data: era_protocol::ProtocolBytes::new(chunk.to_vec()),
                }),
                None,
            )?;
            if index % 8 == 7 {
                self.pump_transfer_progress()?;
            }
        }
        let commit_message = self.submit_runtime(
            &RuntimeMessage::StateImportCommit(StateImportCommit { transfer_id }),
            None,
        )?;
        let ready_transfer = self.wait_for_transfer_event(
            "state_import_ready",
            commit_message,
            "compiled cache import did not complete",
        )?;
        if ready_transfer != transfer_id {
            return Err("compiled cache import returned a different transfer id".into());
        }
        self.load_project_request(identity, None, Some(transfer_id))
    }

    fn load_project_request(
        &mut self,
        identity: ProjectIdentity,
        manifest: Option<ProjectManifest>,
        compiled_cache_transfer_id: Option<u64>,
    ) -> Result<u64, String> {
        self.submit_runtime(
            &RuntimeMessage::ProjectLoad(ProjectLoadRequest {
                identity,
                manifest,
                compiled_cache_transfer_id,
            }),
            None,
        )
    }

    fn wait_for_transfer_event(
        &mut self,
        event_type: &str,
        correlation_id: u64,
        missing_message: &str,
    ) -> Result<u64, String> {
        for _ in 0..4096 {
            let batch = self.pump(RuntimeDriveBudget::default())?;
            for event in batch.events {
                let message_type = event
                    .message
                    .get("type")
                    .and_then(serde_json::Value::as_str);
                if message_type == Some("command_rejected")
                    && event.correlation_id == Some(correlation_id)
                {
                    let message = event
                        .message
                        .pointer("/value/message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("runtime rejected state transfer");
                    return Err(message.to_owned());
                }
                if message_type == Some(event_type) {
                    return event
                        .message
                        .pointer("/value/transfer_id")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| format!("{event_type} omitted its transfer id"));
                }
            }
        }
        Err(missing_message.to_owned())
    }

    fn pump_transfer_progress(&mut self) -> Result<(), String> {
        let batch = self.pump(RuntimeDriveBudget::default())?;
        if let Some(rejection) = batch.events.into_iter().find(|event| {
            event
                .message
                .get("type")
                .and_then(serde_json::Value::as_str)
                == Some("command_rejected")
        }) {
            return Err(rejection
                .message
                .pointer("/value/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("runtime rejected compiled cache data")
                .to_owned());
        }
        Ok(())
    }

    /// Drive a bounded slice and return typed JSON projections of every output envelope.
    ///
    /// # Errors
    ///
    /// Returns an error for runtime faults in the bridge or invalid outbound envelopes.
    pub fn pump(&mut self, budget: RuntimeDriveBudget) -> Result<PumpBatch, String> {
        let report = self
            .runtime
            .drive(budget)
            .map_err(|error| error.to_string())?;
        let mut events = Vec::new();
        let mut acknowledge_through = None;
        while let Some(bytes) = self.runtime.poll_envelope() {
            let envelope =
                decode_envelope(&bytes, self.wire_limits).map_err(|error| error.to_string())?;
            if let Some(epoch) = envelope.session_epoch {
                self.epoch = Some(epoch);
            }
            let (channel, message) = match envelope.channel {
                Channel::Runtime => {
                    let message = RuntimeMessage::from_envelope(&envelope)
                        .map_err(|error| error.to_string())?;
                    if let RuntimeMessage::ServerHello(ServerHello { session, epoch, .. }) =
                        &message
                    {
                        self.session = Some(*session);
                        self.epoch = Some(SessionEpoch(*epoch));
                    }
                    acknowledge_through = Some(envelope.sequence);
                    (WebChannel::Runtime, serde_json::to_value(message))
                }
                Channel::Debug => (
                    WebChannel::Debug,
                    serde_json::to_value(
                        DebugMessage::from_envelope(&envelope)
                            .map_err(|error| error.to_string())?,
                    ),
                ),
            };
            events.push(WebEvent {
                channel,
                sequence: envelope.sequence,
                message_id: envelope.message_id,
                correlation_id: envelope.correlation_id,
                epoch: envelope.session_epoch.map(|value| value.0),
                message: message.map_err(|error| error.to_string())?,
            });
        }
        if let Some(through_sequence) = acknowledge_through {
            self.submit_runtime(
                &RuntimeMessage::Acknowledge(SequenceAcknowledgement { through_sequence }),
                None,
            )?;
        }
        Ok(PumpBatch {
            state: report.state.into(),
            vm_instructions: report.vm_instructions,
            runtime_transitions: report.runtime_transitions,
            events,
        })
    }

    #[must_use]
    pub const fn is_negotiated(&self) -> bool {
        self.session.is_some() && self.epoch.is_some()
    }

    fn take_message_id(&mut self) -> u64 {
        let value = self.next_message_id;
        self.next_message_id = self.next_message_id.saturating_add(1);
        value
    }
}

impl From<RuntimeDriveState> for WebDriveState {
    fn from(value: RuntimeDriveState) -> Self {
        match value {
            RuntimeDriveState::Idle => Self::Idle,
            RuntimeDriveState::MoreWork => Self::MoreWork,
            RuntimeDriveState::OutputReady => Self::OutputReady,
            RuntimeDriveState::Stopped => Self::Stopped,
            RuntimeDriveState::Faulted => Self::Faulted,
        }
    }
}

/// Calculate the exact project identity used by the runtime cache contract.
///
/// # Errors
///
/// Returns an error if a submitted file is missing its 32-byte content hash.
pub fn project_identity(manifest: &ProjectManifest) -> Result<ProjectIdentity, String> {
    let mut files = manifest.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    let mut hasher = blake3::Hasher::new_derive_key("rustyera.project-source-identity.v1");
    for file in files {
        let digest = file
            .content_hash
            .as_ref()
            .ok_or_else(|| format!("project file {} has no content hash", file.relative_path))?;
        if digest.as_slice().len() != 32 {
            return Err(format!(
                "project file {} has an invalid content hash",
                file.relative_path
            ));
        }
        let path = file.relative_path.as_bytes();
        hasher.update(&(path.len() as u64).to_le_bytes());
        hasher.update(path);
        hasher.update(&[file.category as u8]);
        hasher.update(digest.as_slice());
    }
    Ok(ProjectIdentity {
        project_revision: manifest.project_revision,
        source_digest: era_protocol::ProtocolBytes::new(hasher.finalize().as_bytes().to_vec()),
    })
}

fn client_hello(options: WebSessionOptions, limits: RuntimeLimits) -> ClientHello {
    let v1 = VersionRange::exact(era_protocol::ProtocolVersion::new(1, 0));
    let services = [
        (ServiceKind::Entropy, "random_seed"),
        (ServiceKind::Clock, "local_date_time"),
        (ServiceKind::InputState, "get_key_state"),
        (ServiceKind::Image, "image_metadata"),
        (ServiceKind::Image, "image_pixel"),
        (ServiceKind::PresentationQuery, "get_display_line"),
        (ServiceKind::PresentationQuery, "html_get_printed_str"),
        (ServiceKind::PresentationQuery, "serialize_physical_history"),
        (ServiceKind::FontMetrics, "gget_text_size"),
    ]
    .into_iter()
    .map(|(kind, operation)| ServiceCapability {
        kind,
        operation: operation.into(),
        versions: v1,
    })
    .collect();
    ClientHello {
        runtime_versions: VersionRange::exact(RUNTIME_PROTOCOL_VERSION),
        client_name: options.client_name,
        features: vec![
            RuntimeFeature::ProjectReload,
            RuntimeFeature::TraditionalSave,
            RuntimeFeature::VmSnapshot,
            RuntimeFeature::TimedInput,
            RuntimeFeature::RichText,
            RuntimeFeature::Html,
            RuntimeFeature::Graphics,
            RuntimeFeature::Audio,
            RuntimeFeature::MouseInput,
            RuntimeFeature::ExternalServices,
            RuntimeFeature::StateResynchronization,
            RuntimeFeature::Storage,
            RuntimeFeature::InputUndo,
            RuntimeFeature::ProjectAnalysis,
            RuntimeFeature::KeyMacros,
        ],
        requested_limits: limits,
        capabilities: ClientCapabilities {
            input_modalities: vec![InputModality::Keyboard, InputModality::Mouse],
            rich_text: true,
            html: true,
            graphics: true,
            audio: options.audio_available,
            video: false,
            font_metrics: true,
            column_cells: true,
            separators: true,
            available_fonts: options.available_fonts,
            services,
            storage: StorageCapabilities {
                revisions: true,
                atomic_replace: true,
                missing_precondition: true,
                delete: true,
            },
        },
        preferred_locales: options.preferred_locales,
        configuration_profile: Some(options.configuration_profile),
    }
}

fn default_client_name() -> String {
    "rustyera-vue-web".into()
}

fn default_locales() -> Vec<String> {
    vec!["zh-CN".into(), "ja".into(), "en".into()]
}

const fn default_true() -> bool {
    true
}

const fn default_debug_scope_mask() -> u64 {
    DEBUG_SCOPE_ALL
}

const fn default_envelope_bytes() -> u64 {
    DEFAULT_ENVELOPE_BYTES
}

const fn default_configuration_profile() -> ConfigurationClientProfile {
    ConfigurationClientProfile::Browser
}

/// All scopes requested by the debugger preference toggle.
#[must_use]
pub fn all_debug_scopes() -> Vec<DebugScope> {
    vec![
        DebugScope::VariablesRead,
        DebugScope::VariablesWrite,
        DebugScope::GameFieldsRead,
        DebugScope::GameFieldsWrite,
        DebugScope::ExecutionRead,
        DebugScope::ExecutionControl,
        DebugScope::ConsoleEvaluate,
        DebugScope::ConsoleExecute,
        DebugScope::BreakpointsManage,
        DebugScope::ScriptOutput,
    ]
}

#[must_use]
pub const fn debug_protocol_version() -> era_protocol::ProtocolVersion {
    DEBUG_PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use era_protocol::ProtocolBytes;
    use era_runtime_protocol::{FileCategory, FilePayload, SubmittedFile};

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
    fn identity_is_deterministic_across_manifest_order() {
        let make = |path: &str, byte: u8| SubmittedFile {
            relative_path: path.into(),
            category: FileCategory::Erb,
            payload: FilePayload::Utf8(String::from("@TEST\nRETURN")),
            content_hash: Some(ProtocolBytes::new(vec![byte; 32])),
        };
        let left = ProjectManifest {
            project_revision: 7,
            files: vec![make("ERB/b.erb", 2), make("ERB/a.erb", 1)],
        };
        let right = ProjectManifest {
            project_revision: 7,
            files: vec![make("ERB/a.erb", 1), make("ERB/b.erb", 2)],
        };
        assert_eq!(
            project_identity(&left).unwrap(),
            project_identity(&right).unwrap()
        );
    }
}
