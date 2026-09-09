//! Shared checked session bridge for the Tauri and WebAssembly frontends.
//!
//! The bridge deliberately exposes serde projections rather than duplicating the
//! integer-keyed CBOR contract in TypeScript. Both web hosts still exercise the
//! exact same versioned runtime and debug envelopes as the C ABI frontend.

use era_debug_protocol::{DEBUG_PROTOCOL_VERSION, DebugMessage, DebugScope};
use era_protocol::{
    Channel, SessionEpoch, SessionId, WireLimits, decode_envelope, encode_envelope,
};
use era_runtime::{
    ProjectProgressReporter, RuntimeDriveBudget, RuntimeDriveState, RuntimeOptions, RuntimeSession,
};
use era_runtime_protocol::{
    ConfigurationClientProfile, ExternalResource, FileCategory, FilePayload,
    ProjectCompatibilityResolved, ProjectIdentity, ProjectLoadRequest, ProjectManifest,
    ResolveProjectCompatibility, RuntimeLimits, RuntimeMessage, SequenceAcknowledgement,
    ServerHello, ServiceRequest, ServiceResponse, SqlProviderHandleV1, StorageRequest,
    StorageResponse, SubmittedFile,
};
use erabasic_vm::VmConfig;
use serde::{Deserialize, Serialize};

mod client_hello;
mod project_file_identity;
use client_hello::client_hello;
pub use project_file_identity::{
    ProjectFileIdentitySummary, inspect_project_file_identity, project_identity,
};

const DEFAULT_ENVELOPE_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_TRANSFER_BYTES: u64 = 1024 * 1024 * 1024;
const DEBUG_SCOPE_ALL: u64 = (1 << 10) - 1;
pub const FRONTEND_PUMP_MAXIMUM_QUIET_SLICES: usize = 16;
const NATIVE_PUMP_WALL_TIME: std::time::Duration = std::time::Duration::from_millis(8);
const MAXIMUM_PENDING_NATIVE_REQUESTS: usize = 128;

/// Single mutable owner of native storage and service providers.
pub trait NativeHostHandler {
    fn handle_storage(&mut self, request: StorageRequest) -> StorageResponse;
    fn handle_service(&mut self, request: ServiceRequest) -> Option<ServiceResponse>;

    /// Owned services must return a response and never fall back to the frontend.
    fn owns_service(&self, _request: &ServiceRequest) -> bool {
        false
    }

    /// Synchronize authoritative provider roles after each actual runtime drive.
    ///
    /// # Errors
    /// Returns the host's provider synchronization error.
    fn sync_sql_providers(
        &mut self,
        _live: SqlProviderHandleV1,
        _candidate: Option<SqlProviderHandleV1>,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Observe a completion only after its response envelope was successfully submitted.
    ///
    /// # Errors
    /// The recorder must retain a sticky capture failure before returning an error.
    /// Audit errors are observed out of action and never fail an already submitted batch.
    #[cfg(feature = "performance-audit")]
    fn record_completion(&mut self, _completion: NativeCompletionEvidence) -> Result<(), String> {
        Ok(())
    }
}

/// Owned audit evidence. Payloads remain protocol byte buffers, never JSON trees.
#[cfg(feature = "performance-audit")]
#[derive(Clone, Debug)]
pub struct NativeCompletionEvidence {
    pub request: NativeRequestEvidence,
    pub response: RuntimeMessage,
    pub response_message_id: u64,
}

#[cfg(feature = "performance-audit")]
#[derive(Clone, Debug)]
pub struct NativeRequestEvidence {
    pub sequence: u64,
    pub message_id: u64,
    pub correlation_id: Option<u64>,
    pub epoch: Option<u64>,
    pub message: RuntimeMessage,
}

#[cfg(feature = "performance-audit")]
impl NativeRequestEvidence {
    fn new(event: &WebEvent, message: RuntimeMessage) -> Self {
        Self {
            sequence: event.sequence,
            message_id: event.message_id,
            correlation_id: event.correlation_id,
            epoch: event.epoch,
            message,
        }
    }
}

struct ClosureNativeHost<S, H> {
    storage: S,
    service: H,
}

impl<S, H> NativeHostHandler for ClosureNativeHost<S, H>
where
    S: FnMut(StorageRequest) -> StorageResponse,
    H: FnMut(ServiceRequest) -> Option<ServiceResponse>,
{
    fn handle_storage(&mut self, request: StorageRequest) -> StorageResponse {
        (self.storage)(request)
    }

    fn handle_service(&mut self, request: ServiceRequest) -> Option<ServiceResponse> {
        (self.service)(request)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionOptions {
    #[serde(default = "default_client_name")]
    pub client_name: String,
    #[serde(default)]
    pub available_fonts: Vec<String>,
    #[serde(default = "default_locales")]
    pub preferred_locales: Vec<String>,
    #[serde(default)]
    pub audio_available: bool,
    #[serde(default = "default_debug_scope_mask")]
    pub debug_scope_mask: u64,
    #[serde(default = "default_envelope_bytes")]
    pub maximum_envelope_bytes: u64,
    #[serde(default = "default_configuration_profile")]
    pub configuration_profile: ConfigurationClientProfile,
    #[serde(default = "default_true")]
    pub retain_project_source_payloads: bool,
}

impl Default for WebSessionOptions {
    fn default() -> Self {
        Self {
            client_name: default_client_name(),
            available_fonts: Vec::new(),
            preferred_locales: default_locales(),
            audio_available: false,
            debug_scope_mask: default_debug_scope_mask(),
            maximum_envelope_bytes: DEFAULT_ENVELOPE_BYTES,
            configuration_profile: default_configuration_profile(),
            retain_project_source_payloads: true,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bytes: Option<WebBytes>,
}

#[derive(Clone, Debug)]
pub struct WebBytes(pub Vec<u8>);

impl Serialize for WebBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Keep bulk export bytes out of the message's JSON number-array projection.
        serializer.serialize_bytes(&self.0)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpBatch {
    pub state: WebDriveState,
    pub immediate_work: bool,
    pub vm_instructions: u64,
    pub runtime_transitions: u32,
    pub cooperative_background_work: bool,
    pub events: Vec<WebEvent>,
}

impl PumpBatch {
    fn append(&mut self, mut next: Self) {
        self.state = next.state;
        self.immediate_work = next.immediate_work;
        self.vm_instructions = self.vm_instructions.saturating_add(next.vm_instructions);
        self.runtime_transitions = self
            .runtime_transitions
            .saturating_add(next.runtime_transitions);
        self.cooperative_background_work |= next.cooperative_background_work;
        self.events.append(&mut next.events);
    }
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
    pending_native: std::collections::VecDeque<PendingNativeRequest>,
}

impl WebSession {
    /// Read opt-in VM frequency evidence outside timed gameplay operations.
    #[cfg(feature = "vm-instruction-profile")]
    #[must_use]
    pub fn instruction_profile_snapshot(&self) -> Option<erabasic_vm::InstructionProfileSnapshot> {
        self.runtime.instruction_profile_snapshot()
    }

    /// Resolve project metadata through the shared public core parser after negotiation.
    ///
    /// # Errors
    ///
    /// Returns an error if the session has not completed its hello exchange.
    pub fn resolve_project_compatibility(
        &self,
        configuration: Option<SubmittedFile>,
    ) -> Result<ProjectCompatibilityResolved, String> {
        if !self.is_negotiated() {
            return Err("project compatibility requires a negotiated session".into());
        }
        Ok(era_runtime::resolve_project_compatibility(
            &ResolveProjectCompatibility {
                request_id: 0,
                configuration,
            },
        ))
    }
    /// Create a negotiated graphics/audio-capable web session.
    ///
    /// # Errors
    ///
    /// Returns an error if the initial `ClientHello` cannot be encoded or queued.
    pub fn new(options: WebSessionOptions) -> Result<Self, String> {
        let limits = session_limits(&options);
        let maximum_envelope_bytes = limits.maximum_envelope_bytes;
        let maximum_payload_bytes = limits.maximum_payload_bytes;
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
            retain_project_source_payloads: options.retain_project_source_payloads,
        });
        let mut session = Self {
            runtime,
            wire_limits,
            session: None,
            epoch: None,
            runtime_sequence: 0,
            debug_sequence: 0,
            next_message_id: 1,
            pending_native: std::collections::VecDeque::new(),
        };
        session.submit_runtime(
            &RuntimeMessage::ClientHello(client_hello(options, limits)),
            None,
        )?;
        Ok(session)
    }

    /// Return the negotiated maximum size of one frontend transfer.
    #[must_use]
    pub const fn maximum_transfer_bytes(&self) -> u64 {
        self.runtime.maximum_transfer_bytes()
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
        self.runtime
            .stage_project_manifest(manifest)
            .map_err(|error| error.to_string())?;
        let result = self.load_project_request(identity, None, None);
        if result.is_err() {
            self.runtime.clear_staged_project_manifest();
        }
        result
    }

    /// Decode and validate the manifest embedded in a self-contained project file.
    ///
    /// # Errors
    ///
    /// Returns an error when the project file is corrupt, unsupported, or exceeds its own
    /// transfer size.
    pub fn project_file_manifest(&self, bytes: &[u8]) -> Result<ProjectManifest, String> {
        let manifest = era_runtime::decode_project_file_frontend_manifest(bytes, bytes.len())
            .map(|decoded| decoded.manifest)
            .map_err(|error| error.to_string())?;
        self.validate_manifest_compatibility(&manifest)?;
        Ok(manifest)
    }

    fn validate_manifest_compatibility(&self, manifest: &ProjectManifest) -> Result<(), String> {
        let configuration = manifest
            .files
            .iter()
            .find(|file| {
                file.relative_path
                    .replace('\\', "/")
                    .eq_ignore_ascii_case("reraconfig.toml")
            })
            .cloned();
        let resolved = self.resolve_project_compatibility(configuration)?;
        let identity = resolved.identity.ok_or_else(|| {
            resolved
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.message.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })?;
        if identity != manifest.compatibility {
            return Err("project compatibility does not match its root configuration".into());
        }
        Ok(())
    }

    /// Submit an already validated portable-project source manifest and return its browser
    /// projection.
    ///
    /// # Errors
    ///
    /// Returns an error when the source manifest cannot be queued for the runtime.
    pub fn load_decoded_project_file(
        &mut self,
        decoded: era_runtime::DecodedProjectFile,
    ) -> Result<ProjectManifest, String> {
        self.load_decoded_project_file_with_message(decoded)
            .map(|(_, manifest)| manifest)
    }

    /// Submit a decoded portable project and retain its request ID for host-owned resources.
    ///
    /// # Errors
    ///
    /// Returns an error when the decoded manifest is invalid or cannot be queued for Runtime.
    pub fn load_decoded_project_file_with_message(
        &mut self,
        decoded: era_runtime::DecodedProjectFile,
    ) -> Result<(u64, ProjectManifest), String> {
        self.validate_manifest_compatibility(&decoded.manifest)?;
        let (runtime_manifest, frontend_manifest) =
            split_browser_project_manifest(decoded.manifest)?;
        let message_id = self.load_project(runtime_manifest)?;
        Ok((message_id, frontend_manifest))
    }

    /// Decode a portable project file, stage its embedded compiled artifact, and return the
    /// compact frontend projection whose resource payloads remain externally owned.
    ///
    /// # Errors
    ///
    /// Returns an error when the project file is invalid or its load request cannot be queued.
    pub fn load_project_file_cache(
        &mut self,
        bytes: &[u8],
    ) -> Result<(u64, ProjectManifest), String> {
        let decoded = self
            .runtime
            .stage_project_file_cache(bytes)
            .map_err(|error| error.to_string())?;
        if let Err(error) = self.validate_manifest_compatibility(&decoded.manifest) {
            self.runtime.clear_staged_project_file_cache();
            return Err(error);
        }
        let result = self.load_project_request(decoded.identity, None, None);
        if result.is_err() {
            self.runtime.clear_staged_project_file_cache();
        }
        result.map(|message_id| (message_id, decoded.manifest))
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

    /// Stage an owned compiled cache without protocol chunk serialization.
    ///
    /// # Errors
    ///
    /// Returns an error if the host staging slot is busy, exceeds limits, or the project request
    /// cannot be queued.
    pub fn load_project_with_compiled_cache(
        &mut self,
        identity: ProjectIdentity,
        cache: Vec<u8>,
    ) -> Result<u64, String> {
        let transfer_id = self
            .runtime
            .stage_compiled_project_cache(cache)
            .map_err(|error| error.to_string())?;
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
            let (channel, message, data_bytes) = match envelope.channel {
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
                    let (message, data_bytes) = project_runtime_message(message);
                    (WebChannel::Runtime, message, data_bytes)
                }
                Channel::Debug => (
                    WebChannel::Debug,
                    serde_json::to_value(
                        DebugMessage::from_envelope(&envelope)
                            .map_err(|error| error.to_string())?,
                    ),
                    None,
                ),
            };
            events.push(WebEvent {
                channel,
                sequence: envelope.sequence,
                message_id: envelope.message_id,
                correlation_id: envelope.correlation_id,
                epoch: envelope.session_epoch.map(|value| value.0),
                message: message.map_err(|error| error.to_string())?,
                data_bytes,
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
            immediate_work: report.immediate_work,
            vm_instructions: report.vm_instructions,
            runtime_transitions: report.runtime_transitions,
            cooperative_background_work: report.cooperative_background_work,
            events,
        })
    }

    /// Coalesce consecutive compute-only drive slices into one host response.
    ///
    /// Worker and native IPC hosts do not need a round trip for a slice that emitted no event and
    /// immediately reports more work. The first observable event, blocked state, terminal state,
    /// or slice cap returns control to the frontend, preserving event ordering and service latency.
    ///
    /// # Errors
    ///
    /// Returns the same runtime and projection errors as [`Self::pump`].
    pub fn pump_quiet(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_slices: usize,
    ) -> Result<PumpBatch, String> {
        coalesce_quiet_pumps(|| self.pump(budget), maximum_slices)
    }

    /// Retain bounded observable output while driving until the runtime blocks or terminates.
    ///
    /// # Errors
    ///
    /// Returns the same runtime and projection errors as [`Self::pump`].
    pub fn pump_until_blocked(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_quiet_slices: usize,
        maximum_batches: usize,
    ) -> Result<PumpBatch, String> {
        coalesce_observable_pumps(
            || self.pump_quiet(budget, maximum_quiet_slices),
            maximum_batches,
        )
    }

    /// Drive the runtime while satisfying selected external requests inside a native host boundary.
    ///
    /// Large saves and runs of small graphics reads remain native bytes instead of crossing a
    /// `WebView` IPC boundary twice. Non-storage events retain their order in the returned batch.
    ///
    /// # Errors
    ///
    /// Returns the same runtime and projection errors as [`Self::pump`].
    pub fn pump_with_native_host(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_quiet_slices: usize,
        maximum_external_requests: usize,
        handle_storage: impl FnMut(StorageRequest) -> StorageResponse,
        handle_service: impl FnMut(ServiceRequest) -> Option<ServiceResponse>,
    ) -> Result<PumpBatch, String> {
        self.pump_with_native_handler(
            budget,
            maximum_quiet_slices,
            maximum_external_requests,
            &mut ClosureNativeHost {
                storage: handle_storage,
                service: handle_service,
            },
        )
    }

    /// Drive bounded observable work with legacy closure providers.
    ///
    /// # Errors
    /// Returns runtime, projection, or native completion errors.
    pub fn pump_with_native_host_until_blocked(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_quiet_slices: usize,
        maximum_batches: usize,
        maximum_external_requests: usize,
        handle_storage: impl FnMut(StorageRequest) -> StorageResponse,
        handle_service: impl FnMut(ServiceRequest) -> Option<ServiceResponse>,
    ) -> Result<PumpBatch, String> {
        self.pump_with_native_handler_until_blocked(
            budget,
            maximum_quiet_slices,
            maximum_batches,
            maximum_external_requests,
            &mut ClosureNativeHost {
                storage: handle_storage,
                service: handle_service,
            },
        )
    }

    /// Drive native requests, returning on the first batch without a native completion.
    ///
    /// # Errors
    /// Returns runtime, provider synchronization, or completion errors.
    pub fn pump_with_native_handler(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_quiet_slices: usize,
        maximum_external_requests: usize,
        handler: &mut impl NativeHostHandler,
    ) -> Result<PumpBatch, String> {
        self.run_native_handler(
            budget,
            NativePumpLimits {
                maximum_quiet_slices,
                maximum_batches: maximum_external_requests.saturating_add(1),
                maximum_external_requests,
                until_blocked: false,
            },
            handler,
        )
    }

    /// Drive bounded observable work using a single native provider owner.
    ///
    /// The 8ms deadline is checked between drives and host requests. A single legitimate
    /// host operation runs to completion even when it exceeds that fairness deadline.
    ///
    /// # Errors
    /// Returns runtime, provider synchronization, or completion errors.
    pub fn pump_with_native_handler_until_blocked(
        &mut self,
        budget: RuntimeDriveBudget,
        maximum_quiet_slices: usize,
        maximum_batches: usize,
        maximum_external_requests: usize,
        handler: &mut impl NativeHostHandler,
    ) -> Result<PumpBatch, String> {
        self.run_native_handler(
            budget,
            NativePumpLimits {
                maximum_quiet_slices,
                maximum_batches,
                maximum_external_requests,
                until_blocked: true,
            },
            handler,
        )
    }

    fn run_native_handler(
        &mut self,
        budget: RuntimeDriveBudget,
        limits: NativePumpLimits,
        handler: &mut impl NativeHostHandler,
    ) -> Result<PumpBatch, String> {
        let start = std::time::Instant::now();
        let mut pending = std::mem::take(&mut self.pending_native);
        let result = drive_native_handler(
            &mut WebSessionNativePumpDriver {
                session: self,
                budget,
            },
            &mut pending,
            limits,
            handler,
            &mut || start.elapsed() >= NATIVE_PUMP_WALL_TIME,
        );
        self.pending_native = pending;
        result
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

fn session_limits(options: &WebSessionOptions) -> RuntimeLimits {
    let maximum_envelope_bytes = options.maximum_envelope_bytes.max(1024 * 1024);
    RuntimeLimits {
        maximum_envelope_bytes,
        maximum_payload_bytes: maximum_envelope_bytes.saturating_sub(1024 * 1024).max(1024),
        maximum_pending_requests: 128,
        maximum_journal_entries: 4096,
        maximum_journal_bytes: DEFAULT_JOURNAL_BYTES,
        maximum_drive_instructions: 1_000_000,
        maximum_transfer_bytes: MAXIMUM_TRANSFER_BYTES,
    }
}

#[cfg(feature = "performance-audit")]
/// Return the exact Core client projection used by a performance-audit session.
#[must_use]
pub fn performance_audit_client(options: WebSessionOptions) -> serde_json::Value {
    let limits = session_limits(&options);
    let hello = client_hello(options, limits);
    serde_json::json!({"features": hello.features, "capabilities": hello.capabilities})
}

trait NativePumpDriver {
    /// Exactly one actual runtime drive.
    fn pump_batch(&mut self) -> Result<PumpBatch, String>;
    fn sql_provider_lifecycle(&self) -> (SqlProviderHandleV1, Option<SqlProviderHandleV1>);
    fn submit_completion(&mut self, completion: &NativeCompletion) -> Result<u64, String>;
}

struct WebSessionNativePumpDriver<'a> {
    session: &'a mut WebSession,
    budget: RuntimeDriveBudget,
}

impl NativePumpDriver for WebSessionNativePumpDriver<'_> {
    fn pump_batch(&mut self) -> Result<PumpBatch, String> {
        self.session.pump(self.budget)
    }

    fn sql_provider_lifecycle(&self) -> (SqlProviderHandleV1, Option<SqlProviderHandleV1>) {
        self.session.runtime.sql_provider_lifecycle()
    }

    fn submit_completion(&mut self, completion: &NativeCompletion) -> Result<u64, String> {
        self.session
            .submit_runtime(&completion.message, completion.correlation_id)
    }
}

#[derive(Clone, Copy)]
struct NativePumpLimits {
    maximum_quiet_slices: usize,
    maximum_batches: usize,
    maximum_external_requests: usize,
    until_blocked: bool,
}

struct PendingNativeRequest {
    request: ServiceRequest,
    correlation_id: Option<u64>,
    terminal_state: Option<WebDriveState>,
    #[cfg(feature = "performance-audit")]
    evidence: NativeRequestEvidence,
}

fn submit_native_completion(
    driver: &mut impl NativePumpDriver,
    handler: &mut impl NativeHostHandler,
    completion: NativeCompletion,
) -> Result<(), String> {
    let response_message_id = driver.submit_completion(&completion)?;
    #[cfg(feature = "performance-audit")]
    let _ = handler.record_completion(NativeCompletionEvidence {
        request: completion.evidence,
        response: completion.message,
        response_message_id,
    });
    #[cfg(not(feature = "performance-audit"))]
    {
        let _ = (handler, response_message_id);
        drop(completion);
    }
    Ok(())
}

fn complete_owned_request(
    driver: &mut impl NativePumpDriver,
    handler: &mut impl NativeHostHandler,
    pending: PendingNativeRequest,
) -> Result<(), String> {
    let response = handler
        .handle_service(pending.request)
        .ok_or_else(|| "native host did not respond to an owned service request".to_owned())?;
    submit_native_completion(
        driver,
        handler,
        NativeCompletion {
            message: RuntimeMessage::ServiceResponse(response),
            correlation_id: pending.correlation_id,
            #[cfg(feature = "performance-audit")]
            evidence: pending.evidence,
        },
    )
}

fn mark_native_more_work(batch: &mut PumpBatch) {
    if !matches!(batch.state, WebDriveState::Stopped | WebDriveState::Faulted) {
        batch.state = WebDriveState::MoreWork;
        batch.immediate_work = true;
    }
}

fn native_quiet_batch(
    driver: &mut impl NativePumpDriver,
    handler: &mut impl NativeHostHandler,
    maximum_slices: usize,
    expired: &mut impl FnMut() -> bool,
) -> Result<PumpBatch, String> {
    let mut combined = None;
    for _ in 0..maximum_slices.max(1) {
        if combined.is_some() && expired() {
            break;
        }
        let batch = driver.pump_batch()?;
        let (live, candidate) = driver.sql_provider_lifecycle();
        handler.sync_sql_providers(live, candidate)?;
        let stop = !batch.events.is_empty()
            || batch.cooperative_background_work
            || !matches!(
                batch.state,
                WebDriveState::MoreWork | WebDriveState::OutputReady
            );
        merge_pump_batch(&mut combined, batch);
        if stop {
            break;
        }
    }
    combined.ok_or_else(|| "native host pump produced no batch".to_owned())
}

fn drive_native_handler(
    driver: &mut impl NativePumpDriver,
    pending: &mut std::collections::VecDeque<PendingNativeRequest>,
    limits: NativePumpLimits,
    handler: &mut impl NativeHostHandler,
    expired: &mut impl FnMut() -> bool,
) -> Result<PumpBatch, String> {
    let mut request_count = 0usize;
    let had_pending = !pending.is_empty();
    let pending_terminal = pending.front().and_then(|request| request.terminal_state);
    // Never drive again while a deferred native request still awaits its owner.
    while !pending.is_empty() && request_count < limits.maximum_external_requests && !expired() {
        let request = pending.pop_front().expect("pending request");
        complete_owned_request(driver, handler, request)?;
        request_count += 1;
    }
    let mut combined = None;
    if had_pending
        && (!pending.is_empty()
            || request_count == limits.maximum_external_requests
            || pending_terminal.is_some()
            || expired())
    {
        return Ok(PumpBatch {
            state: pending_terminal.unwrap_or(WebDriveState::MoreWork),
            immediate_work: pending_terminal.is_none(),
            vm_instructions: 0,
            runtime_transitions: 0,
            cooperative_background_work: false,
            events: Vec::new(),
        });
    }
    for batch_index in 0..limits.maximum_batches.max(1) {
        // Always obtain one actual batch for an otherwise empty call.
        if combined.is_some() && expired() {
            if let Some(batch) = combined.as_mut() {
                mark_native_more_work(batch);
            }
            break;
        }
        let mut batch = native_quiet_batch(driver, handler, limits.maximum_quiet_slices, expired)?;
        let before = request_count;
        batch.events = process_native_events(
            std::mem::take(&mut batch.events),
            driver,
            pending,
            handler,
            &mut request_count,
            limits.maximum_external_requests,
            expired,
        )?;
        let completed = request_count > before;
        let terminal = matches!(batch.state, WebDriveState::Stopped | WebDriveState::Faulted);
        if terminal {
            for request in pending.iter_mut() {
                request.terminal_state = Some(batch.state);
            }
        }
        let active = matches!(
            batch.state,
            WebDriveState::MoreWork | WebDriveState::OutputReady
        );
        let deadline = expired();
        let external_cap = completed && request_count == limits.maximum_external_requests;
        let batch_cap = batch_index + 1 == limits.maximum_batches.max(1);
        let cooperative = batch.cooperative_background_work && limits.until_blocked;
        if !pending.is_empty()
            || (deadline && active)
            || (completed && (deadline || external_cap || batch_cap || cooperative))
        {
            mark_native_more_work(&mut batch);
        }
        merge_pump_batch(&mut combined, batch);
        if terminal
            || deadline
            || external_cap
            || batch_cap
            || cooperative
            || !pending.is_empty()
            || (!completed && (!active || !limits.until_blocked))
        {
            break;
        }
    }
    combined.ok_or_else(|| "native host pump produced no batch".to_owned())
}

fn split_browser_project_manifest(
    mut runtime: ProjectManifest,
) -> Result<(ProjectManifest, ProjectManifest), String> {
    for file in &mut runtime.files {
        if file.content_hash.is_none() {
            file.content_hash = match &file.payload {
                FilePayload::Utf8(value) => Some(era_protocol::ProtocolBytes::new(
                    blake3::hash(value.as_bytes()).as_bytes().to_vec(),
                )),
                FilePayload::Bytes(value) => Some(era_protocol::ProtocolBytes::new(
                    blake3::hash(value.as_slice()).as_bytes().to_vec(),
                )),
                FilePayload::IoError(_) | FilePayload::ExternalResource(_) => None,
            };
        }
    }
    let original_identity = project_identity(&runtime)?;
    let mut frontend_files = Vec::with_capacity(runtime.files.len());
    for file in &mut runtime.files {
        let frontend_payload = if file.category == FileCategory::Resource {
            match &file.payload {
                FilePayload::Bytes(bytes) => {
                    let descriptor = FilePayload::ExternalResource(ExternalResource {
                        byte_length: u64::try_from(bytes.as_slice().len())
                            .map_err(|_| "project resource is too large")?,
                        image_metadata: None,
                    });
                    std::mem::replace(&mut file.payload, descriptor)
                }
                _ => file.payload.clone(),
            }
        } else if file
            .relative_path
            .replace('\\', "/")
            .eq_ignore_ascii_case("reraconfig.toml")
        {
            file.payload.clone()
        } else {
            empty_file_payload(&file.payload)
        };
        frontend_files.push(SubmittedFile {
            relative_path: file.relative_path.clone(),
            category: file.category,
            payload: frontend_payload,
            content_hash: file.content_hash.clone(),
        });
    }
    let frontend = ProjectManifest {
        project_revision: runtime.project_revision,
        files: frontend_files,
        compatibility: runtime.compatibility.clone(),
    };
    if project_identity(&runtime)? != original_identity
        || project_identity(&frontend)? != original_identity
    {
        return Err("browser project projection changed the project identity".into());
    }
    Ok((runtime, frontend))
}

fn empty_file_payload(payload: &FilePayload) -> FilePayload {
    match payload {
        FilePayload::Utf8(_) => FilePayload::Utf8(String::new()),
        FilePayload::Bytes(_) => FilePayload::Bytes(era_protocol::ProtocolBytes::default()),
        FilePayload::IoError(error) => {
            let mut error = error.clone();
            error.message.clear();
            FilePayload::IoError(error)
        }
        FilePayload::ExternalResource(resource) => FilePayload::ExternalResource(resource.clone()),
    }
}

fn project_runtime_message(
    mut message: RuntimeMessage,
) -> (
    Result<serde_json::Value, serde_json::Error>,
    Option<WebBytes>,
) {
    let data_bytes = match &mut message {
        RuntimeMessage::StateExportChunk(chunk) => {
            Some(WebBytes(std::mem::take(&mut chunk.data).into_inner()))
        }
        _ => None,
    };
    (serde_json::to_value(message), data_bytes)
}

#[cfg_attr(test, derive(Clone))]
struct NativeCompletion {
    message: RuntimeMessage,
    correlation_id: Option<u64>,
    #[cfg(feature = "performance-audit")]
    evidence: NativeRequestEvidence,
}

fn merge_pump_batch(combined: &mut Option<PumpBatch>, batch: PumpBatch) {
    if let Some(result) = combined {
        result.append(batch);
    } else {
        *combined = Some(batch);
    }
}

fn process_native_events(
    events: Vec<WebEvent>,
    driver: &mut impl NativePumpDriver,
    pending: &mut std::collections::VecDeque<PendingNativeRequest>,
    handler: &mut impl NativeHostHandler,
    request_count: &mut usize,
    allowance: usize,
    expired: &mut impl FnMut() -> bool,
) -> Result<Vec<WebEvent>, String> {
    let mut visible = Vec::with_capacity(events.len());
    for event in events {
        if event.channel != WebChannel::Runtime {
            visible.push(event);
            continue;
        }
        let available = *request_count < allowance && !expired() && pending.is_empty();
        match event
            .message
            .get("type")
            .and_then(serde_json::Value::as_str)
        {
            Some("storage_request") if available => {
                let RuntimeMessage::StorageRequest(request) =
                    RuntimeMessage::deserialize(&event.message)
                        .map_err(|error| error.to_string())?
                else {
                    return Err("storage request projection decoded to another message".into());
                };
                #[cfg(feature = "performance-audit")]
                let evidence = NativeRequestEvidence::new(
                    &event,
                    RuntimeMessage::StorageRequest(request.clone()),
                );
                let correlation_id = event.correlation_id;
                drop(event);
                let response = handler.handle_storage(request);
                submit_native_completion(
                    driver,
                    handler,
                    NativeCompletion {
                        message: RuntimeMessage::StorageResponse(response),
                        correlation_id,
                        #[cfg(feature = "performance-audit")]
                        evidence,
                    },
                )?;
                *request_count += 1;
            }
            Some("service_request") => {
                // Deserialize directly from the projection: no cloned JSON payload or
                // production audit envelope is kept for a native-owned service.
                let RuntimeMessage::ServiceRequest(request) =
                    RuntimeMessage::deserialize(&event.message)
                        .map_err(|error| error.to_string())?
                else {
                    return Err("service request projection decoded to another message".into());
                };
                if handler.owns_service(&request) {
                    #[cfg(feature = "performance-audit")]
                    let evidence = NativeRequestEvidence::new(
                        &event,
                        RuntimeMessage::ServiceRequest(request.clone()),
                    );
                    let request = PendingNativeRequest {
                        request,
                        correlation_id: event.correlation_id,
                        terminal_state: None,
                        #[cfg(feature = "performance-audit")]
                        evidence,
                    };
                    drop(event);
                    if available {
                        complete_owned_request(driver, handler, request)?;
                        *request_count += 1;
                    } else {
                        // Core's pending-request limit is the same bound. Do not drive
                        // while this queue is nonempty, so it cannot grow across calls.
                        if pending.len() >= MAXIMUM_PENDING_NATIVE_REQUESTS {
                            return Err("native pending request limit exceeded".into());
                        }
                        pending.push_back(request);
                    }
                } else if available {
                    #[cfg(feature = "performance-audit")]
                    let evidence = NativeRequestEvidence::new(
                        &event,
                        RuntimeMessage::ServiceRequest(request.clone()),
                    );
                    if let Some(response) = handler.handle_service(request) {
                        let correlation_id = event.correlation_id;
                        drop(event);
                        submit_native_completion(
                            driver,
                            handler,
                            NativeCompletion {
                                message: RuntimeMessage::ServiceResponse(response),
                                correlation_id,
                                #[cfg(feature = "performance-audit")]
                                evidence,
                            },
                        )?;
                        *request_count += 1;
                    } else {
                        visible.push(event);
                    }
                } else {
                    visible.push(event);
                }
            }
            _ => visible.push(event),
        }
    }
    Ok(visible)
}

fn coalesce_quiet_pumps(
    mut pump: impl FnMut() -> Result<PumpBatch, String>,
    maximum_slices: usize,
) -> Result<PumpBatch, String> {
    let maximum_slices = maximum_slices.max(1);
    let mut combined = pump()?;
    for _ in 1..maximum_slices {
        if !combined.events.is_empty()
            || combined.cooperative_background_work
            || !matches!(
                combined.state,
                WebDriveState::MoreWork | WebDriveState::OutputReady
            )
        {
            break;
        }
        combined.append(pump()?);
    }
    Ok(combined)
}

fn coalesce_observable_pumps(
    mut pump: impl FnMut() -> Result<PumpBatch, String>,
    maximum_batches: usize,
) -> Result<PumpBatch, String> {
    let maximum_batches = maximum_batches.max(1);
    let mut combined = pump()?;
    for _ in 1..maximum_batches {
        if combined.cooperative_background_work
            || !matches!(
                combined.state,
                WebDriveState::MoreWork | WebDriveState::OutputReady
            )
        {
            break;
        }
        combined.append(pump()?);
    }
    Ok(combined)
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
mod tests;
