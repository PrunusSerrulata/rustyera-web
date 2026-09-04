//! WebAssembly bindings for the shared `RustyEra` web session bridge.

use era_debug_protocol::DebugMessage;
use era_runtime::{ProjectProgressReporter, RuntimeDriveBudget};
use era_runtime_protocol::{
    ExternalResource, FileCategory, FilePayload, ProjectManifest, ProtocolBytes, RuntimeMessage,
    SubmittedFile,
};
use era_web_bridge::{
    FRONTEND_PUMP_MAXIMUM_QUIET_SLICES, WebSession, WebSessionOptions, project_identity,
};
use serde::de::DeserializeOwned;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use wasm_bindgen::prelude::*;

mod browser_manifest;
use browser_manifest::{decode_browser_manifest, decode_external_resource, decode_file_category};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmProjectProgress {
    stage: era_runtime::ProjectProgressStage,
    completed: u32,
    total: u32,
    elapsed_ms: f64,
    memory_bytes: u32,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmPumpBatch {
    #[serde(flatten)]
    batch: era_web_bridge::PumpBatch,
    memory_bytes: u32,
}

#[wasm_bindgen]
pub struct WasmRuntime {
    inner: WebSession,
    project_manifest_upload: ProjectManifestUpload,
    project_file_upload: ProjectFileUpload,
    project_file_resources: ProjectFileResources,
}

struct PendingProjectManifest {
    manifest: ProjectManifest,
    expected_files: usize,
    received_bytes: usize,
    maximum_bytes: usize,
}

#[derive(Default)]
struct ProjectManifestUpload {
    pending: Option<PendingProjectManifest>,
}

impl ProjectManifestUpload {
    const HEADER_BYTES: usize = 24;
    const FILE_FIXED_BYTES: usize = 15;

    fn begin(
        &mut self,
        project_revision: u64,
        expected_files: usize,
        compatibility: era_runtime_protocol::CompatibilityIdentity,
        maximum_bytes: usize,
    ) -> Result<(), String> {
        if self.pending.is_some() {
            return Err("a browser project manifest upload is already active".to_owned());
        }
        let header_bytes = Self::HEADER_BYTES
            + serde_json::to_vec(&compatibility)
                .map_err(|error| error.to_string())?
                .len();
        let minimum_bytes = expected_files
            .checked_mul(Self::FILE_FIXED_BYTES)
            .and_then(|bytes| bytes.checked_add(header_bytes))
            .ok_or_else(|| "browser project manifest size overflow".to_owned())?;
        if minimum_bytes > maximum_bytes {
            return Err(
                "browser project manifest file count exceeds its transfer limit".to_owned(),
            );
        }
        self.pending = Some(PendingProjectManifest {
            manifest: ProjectManifest {
                project_revision,
                files: Vec::new(),
                compatibility,
            },
            expected_files,
            received_bytes: header_bytes,
            maximum_bytes,
        });
        Ok(())
    }

    fn preflight(
        &self,
        relative_path_bytes: usize,
        payload_bytes: usize,
        hash_bytes: usize,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| "no browser project manifest upload is active".to_owned())?;
        if pending.manifest.files.len() >= pending.expected_files {
            return Err("browser project manifest has more files than declared".to_owned());
        }
        let file_bytes = Self::FILE_FIXED_BYTES
            .checked_add(relative_path_bytes)
            .and_then(|bytes| bytes.checked_add(payload_bytes))
            .and_then(|bytes| bytes.checked_add(hash_bytes))
            .ok_or_else(|| "browser project manifest size overflow".to_owned())?;
        pending
            .received_bytes
            .checked_add(file_bytes)
            .filter(|bytes| *bytes <= pending.maximum_bytes)
            .ok_or_else(|| "browser project manifest exceeds its transfer limit".to_owned())?;
        Ok(())
    }

    fn append(&mut self, file: SubmittedFile) -> Result<(), String> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| "no browser project manifest upload is active".to_owned())?;
        if pending.manifest.files.len() >= pending.expected_files {
            return Err("browser project manifest has more files than declared".to_owned());
        }
        let payload_bytes = match &file.payload {
            FilePayload::Utf8(value) => value.len(),
            FilePayload::Bytes(value) => value.as_slice().len(),
            FilePayload::ExternalResource(_) => 18,
            FilePayload::IoError(error) => error.message.len(),
        };
        let hash_bytes = file
            .content_hash
            .as_ref()
            .map_or(0, |hash| hash.as_slice().len());
        let file_bytes = Self::FILE_FIXED_BYTES
            .checked_add(file.relative_path.len())
            .and_then(|bytes| bytes.checked_add(payload_bytes))
            .and_then(|bytes| bytes.checked_add(hash_bytes))
            .ok_or_else(|| "browser project manifest size overflow".to_owned())?;
        pending.received_bytes = pending
            .received_bytes
            .checked_add(file_bytes)
            .filter(|bytes| *bytes <= pending.maximum_bytes)
            .ok_or_else(|| "browser project manifest exceeds its transfer limit".to_owned())?;
        pending.manifest.files.push(file);
        Ok(())
    }

    fn finish(&mut self) -> Result<ProjectManifest, String> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| "no browser project manifest upload is active".to_owned())?;
        if pending.manifest.files.len() != pending.expected_files {
            return Err(format!(
                "browser project manifest upload is incomplete: received {} of {} files",
                pending.manifest.files.len(),
                pending.expected_files
            ));
        }
        self.pending
            .take()
            .map(|completed| completed.manifest)
            .ok_or_else(|| "no browser project manifest upload is active".to_owned())
    }

    fn cancel(&mut self) {
        self.pending = None;
    }
}

struct PendingProjectFile {
    bytes: Vec<u8>,
    expected_len: usize,
}

#[derive(Default)]
struct ProjectFileUpload {
    pending: Option<PendingProjectFile>,
}

impl ProjectFileUpload {
    fn begin(&mut self, expected_len: usize, maximum_len: usize) -> Result<(), String> {
        if self.pending.is_some() {
            return Err("a project file upload is already active".to_owned());
        }
        if expected_len > maximum_len {
            return Err("project file exceeds the negotiated transfer limit".to_owned());
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(expected_len)
            .map_err(|error| format!("failed to reserve project file buffer: {error}"))?;
        self.pending = Some(PendingProjectFile {
            bytes,
            expected_len,
        });
        Ok(())
    }

    fn append_destination(&mut self, chunk_len: usize) -> Result<&mut [u8], String> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| "no project file upload is active".to_owned())?;
        let start = pending.bytes.len();
        let end = start
            .checked_add(chunk_len)
            .ok_or_else(|| "project file size overflow".to_owned())?;
        if end > pending.expected_len {
            return Err("project file upload exceeds its declared size".to_owned());
        }
        pending.bytes.resize(end, 0);
        Ok(&mut pending.bytes[start..end])
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| "no project file upload is active".to_owned())?;
        if pending.bytes.len() != pending.expected_len {
            return Err(format!(
                "project file upload is incomplete: received {} of {} bytes",
                pending.bytes.len(),
                pending.expected_len
            ));
        }
        self.pending
            .take()
            .map(|completed| completed.bytes)
            .ok_or_else(|| "no project file upload is active".to_owned())
    }

    fn cancel(&mut self) {
        self.pending = None;
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedProjectFile {
    manifest: ProjectManifest,
    storage_key: String,
    cache_imported: bool,
}

fn take_project_file_resources(manifest: &mut ProjectManifest) -> BTreeMap<String, Vec<u8>> {
    let mut resources = BTreeMap::new();
    for file in &mut manifest.files {
        if file.category != FileCategory::Resource {
            continue;
        }
        let FilePayload::Bytes(bytes) = &mut file.payload else {
            continue;
        };
        let key = file.relative_path.replace('\\', "/").to_lowercase();
        let value = std::mem::take(bytes).into_inner();
        file.payload = FilePayload::ExternalResource(ExternalResource {
            byte_length: u64::try_from(value.len()).unwrap_or(u64::MAX),
            image_metadata: None,
        });
        let previous = resources.insert(key, value);
        debug_assert!(previous.is_none());
    }
    resources
}

fn stage_project_file_bytes(runtime: &mut WasmRuntime, bytes: &[u8]) -> Result<JsValue, JsValue> {
    let storage_key = blake3::hash(bytes).to_hex().to_string();
    let (message_id, mut manifest) = runtime
        .inner
        .load_project_file_cache(bytes)
        .map_err(js_error)?;
    let resources = take_project_file_resources(&mut manifest);
    runtime
        .project_file_resources
        .stage_packaged(message_id, resources);
    to_js(LoadedProjectFile {
        manifest,
        storage_key,
        cache_imported: true,
    })
}

fn stage_project_file_with_compiled_cache(
    runtime: &mut WasmRuntime,
    project_file: &[u8],
    compiled_cache: &[u8],
) -> Result<JsValue, JsValue> {
    let storage_key = blake3::hash(project_file).to_hex().to_string();
    // Decode only the portable manifest here. The sidecar owns the compiled artifact, so parsing
    // the obsolete artifact embedded in an older project file would erase the warm-start win.
    let mut decoded =
        era_runtime::decode_project_file_frontend_manifest(project_file, project_file.len())
            .map_err(js_error)?;
    let resources = take_project_file_resources(&mut decoded.manifest);
    let message_id = runtime
        .inner
        .load_project_with_compiled_cache(decoded.identity, compiled_cache.to_vec())
        .map_err(js_error)?;
    runtime
        .project_file_resources
        .stage_packaged(message_id, resources);
    to_js(LoadedProjectFile {
        manifest: decoded.manifest,
        storage_key,
        cache_imported: true,
    })
}

fn stage_project_file_source(runtime: &mut WasmRuntime, bytes: &[u8]) -> Result<JsValue, JsValue> {
    let storage_key = blake3::hash(bytes).to_hex().to_string();
    let decoded = era_runtime::decode_project_file(bytes, bytes.len()).map_err(js_error)?;
    let (message_id, mut manifest) = runtime
        .inner
        .load_decoded_project_file_with_message(decoded)
        .map_err(js_error)?;
    let resources = take_project_file_resources(&mut manifest);
    runtime
        .project_file_resources
        .stage_packaged(message_id, resources);
    to_js(LoadedProjectFile {
        manifest,
        storage_key,
        cache_imported: false,
    })
}

#[derive(Default)]
struct ProjectFileResources {
    active: BTreeMap<String, Vec<u8>>,
    candidate: Option<(u64, BTreeMap<String, Vec<u8>>)>,
    pending_replacements: BTreeSet<u64>,
}

impl ProjectFileResources {
    fn stage_packaged(&mut self, message_id: u64, resources: BTreeMap<String, Vec<u8>>) {
        self.candidate = Some((message_id, resources));
    }

    fn track_replacement(&mut self, message_id: u64) {
        self.pending_replacements.insert(message_id);
    }

    fn complete_replacement(&mut self, message_id: u64, success: bool) {
        if self
            .candidate
            .as_ref()
            .is_some_and(|(candidate_id, _)| *candidate_id == message_id)
        {
            let (_, candidate) = self.candidate.take().expect("matching candidate exists");
            if success {
                self.active = candidate;
                self.pending_replacements.clear();
            }
            return;
        }
        if self.pending_replacements.remove(&message_id) && success {
            self.active.clear();
        }
    }

    fn get(&self, relative_path: &str) -> Option<&[u8]> {
        if let Some((_, resources)) = &self.candidate {
            return resources.get(relative_path).map(Vec::as_slice);
        }
        self.active.get(relative_path).map(Vec::as_slice)
    }
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Create a runtime. The options object uses the same camel-case shape on both hosts.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the options cannot be decoded or the runtime cannot start.
    #[wasm_bindgen(constructor)]
    pub fn new(
        options: JsValue,
        progress_callback: Option<js_sys::Function>,
    ) -> Result<WasmRuntime, JsValue> {
        let options = if options.is_null() || options.is_undefined() {
            WebSessionOptions::default()
        } else {
            from_js(options)?
        };
        let mut inner = WebSession::new(options).map_err(js_error)?;
        let progress_started_ms = js_sys::Date::now();
        if let Some(progress_callback) = progress_callback {
            inner.set_project_progress_reporter(Some(ProjectProgressReporter::new_with_elapsed(
                move |progress| {
                    if let Ok(value) = to_js(WasmProjectProgress {
                        stage: progress.stage,
                        completed: u32::try_from(progress.completed).unwrap_or(u32::MAX),
                        total: u32::try_from(progress.total).unwrap_or(u32::MAX),
                        elapsed_ms: (js_sys::Date::now() - progress_started_ms).max(0.0),
                        memory_bytes: wasm_memory_bytes(),
                    }) {
                        let _ = progress_callback.call1(&JsValue::UNDEFINED, &value);
                    }
                },
                move || {
                    Duration::from_secs_f64(
                        ((js_sys::Date::now() - progress_started_ms).max(0.0)) / 1000.0,
                    )
                },
            )));
        }
        Ok(Self {
            inner,
            project_manifest_upload: ProjectManifestUpload::default(),
            project_file_upload: ProjectFileUpload::default(),
            project_file_resources: ProjectFileResources::default(),
        })
    }

    /// Submit one serde-projected runtime message.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error for invalid message data or runtime protocol failures.
    #[wasm_bindgen(js_name = submitRuntime)]
    pub fn submit_runtime(
        &mut self,
        message: JsValue,
        correlation_id: Option<u64>,
    ) -> Result<JsValue, JsValue> {
        let message: RuntimeMessage = from_js(message)?;
        to_js(
            self.inner
                .submit_runtime(&message, correlation_id)
                .map_err(js_error)?,
        )
    }

    /// Submit one serde-projected debug message.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error for invalid message data or debug protocol failures.
    #[wasm_bindgen(js_name = submitDebug)]
    pub fn submit_debug(
        &mut self,
        message: JsValue,
        correlation_id: Option<u64>,
    ) -> Result<JsValue, JsValue> {
        let message: DebugMessage = from_js(message)?;
        to_js(
            self.inner
                .submit_debug(&message, correlation_id)
                .map_err(js_error)?,
        )
    }

    /// Submit a materialized UTF-8/binary project manifest.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the manifest is invalid or cannot be queued.
    #[wasm_bindgen(js_name = loadProject)]
    pub fn load_project(&mut self, manifest: JsValue) -> Result<JsValue, JsValue> {
        let manifest: ProjectManifest = from_js(manifest)?;
        let message_id = self.inner.load_project(manifest).map_err(js_error)?;
        self.project_file_resources.track_replacement(message_id);
        to_js(message_id)
    }

    /// Resolve the root configuration with the public core parser, without constructing a VM.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed wire input or an unnegotiated session.
    #[wasm_bindgen(js_name = resolveProjectCompatibility)]
    pub fn resolve_project_compatibility(
        &self,
        configuration: JsValue,
    ) -> Result<JsValue, JsValue> {
        let configuration: Option<SubmittedFile> = from_js(configuration)?;
        to_js(
            self.inner
                .resolve_project_compatibility(configuration)
                .map_err(js_error)?,
        )
    }

    /// Decode and submit the browser's compact binary manifest transport.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the transport is malformed or cannot be queued.
    #[wasm_bindgen(js_name = loadProjectBinary)]
    pub fn load_project_binary(&mut self, bytes: &js_sys::Uint8Array) -> Result<JsValue, JsValue> {
        let manifest = decode_browser_manifest(&bytes.to_vec()).map_err(js_error)?;
        let message_id = self.inner.load_project(manifest).map_err(js_error)?;
        self.project_file_resources.track_replacement(message_id);
        to_js(message_id)
    }

    /// Begin receiving a browser directory manifest one final-owned file at a time.
    ///
    /// # Errors
    ///
    /// Returns an error when an upload is already active or the declared file table exceeds the
    /// negotiated transfer bound.
    #[wasm_bindgen(js_name = beginProjectManifest)]
    pub fn begin_project_manifest(
        &mut self,
        project_revision: u64,
        file_count: u32,
        compatibility: JsValue,
    ) -> Result<(), JsValue> {
        let maximum = usize::try_from(self.inner.maximum_transfer_bytes()).unwrap_or(usize::MAX);
        self.project_manifest_upload
            .begin(
                project_revision,
                usize::try_from(file_count)
                    .map_err(|_| js_error("browser project file count is unsupported"))?,
                from_js(compatibility)?,
                maximum,
            )
            .map_err(js_error)
    }

    /// Append one browser directory file without retaining a complete encoded manifest buffer.
    ///
    /// # Errors
    ///
    /// Returns an error when the upload is absent, complete, or contains an invalid category,
    /// payload, external descriptor, or content hash.
    #[wasm_bindgen(js_name = appendProjectManifestFile)]
    pub fn append_project_manifest_file(
        &mut self,
        relative_path: String,
        category: u8,
        payload_tag: u8,
        payload: &js_sys::Uint8Array,
        content_hash: &js_sys::Uint8Array,
    ) -> Result<(), JsValue> {
        let category = decode_file_category(category).map_err(js_error)?;
        let payload_bytes = usize::try_from(payload.length())
            .map_err(|_| js_error("browser project payload length is unsupported"))?;
        match payload_tag {
            0 | 1 => {}
            2 if payload_bytes == 18 => {}
            2 => {
                return Err(js_error(
                    "browser external resource descriptor must be 18 bytes",
                ));
            }
            _ => return Err(js_error("browser project payload tag is invalid")),
        }
        let hash_bytes = usize::try_from(content_hash.length())
            .map_err(|_| js_error("browser project hash length is unsupported"))?;
        if !matches!(hash_bytes, 0 | 32) {
            return Err(js_error(
                "browser project content hash must be empty or 32 bytes",
            ));
        }
        self.project_manifest_upload
            .preflight(relative_path.len(), payload_bytes, hash_bytes)
            .map_err(js_error)?;
        let payload = copy_uint8_array(payload).map_err(js_error)?;
        let payload = match payload_tag {
            0 => FilePayload::Utf8(
                String::from_utf8(payload)
                    .map_err(|_| js_error("browser project text payload is not UTF-8"))?,
            ),
            1 => FilePayload::Bytes(ProtocolBytes::new(payload)),
            2 => decode_external_resource(&payload).map_err(js_error)?,
            _ => unreachable!("payload tag was checked before copying"),
        };
        let content_hash = match hash_bytes {
            0 => None,
            32 => Some(ProtocolBytes::new(
                copy_uint8_array(content_hash).map_err(js_error)?,
            )),
            _ => unreachable!("hash length was checked before copying"),
        };
        self.project_manifest_upload
            .append(SubmittedFile {
                relative_path,
                category,
                payload,
                content_hash,
            })
            .map_err(js_error)
    }

    /// Submit a complete directly owned browser directory manifest to Runtime.
    ///
    /// # Errors
    ///
    /// Returns an error when the upload is incomplete or Runtime rejects the manifest.
    #[wasm_bindgen(js_name = finishProjectManifest)]
    pub fn finish_project_manifest(&mut self) -> Result<JsValue, JsValue> {
        let manifest = self.project_manifest_upload.finish().map_err(js_error)?;
        let message_id = self.inner.load_project(manifest).map_err(js_error)?;
        self.project_file_resources.track_replacement(message_id);
        to_js(message_id)
    }

    /// Discard an incomplete browser directory manifest upload.
    #[wasm_bindgen(js_name = cancelProjectManifest)]
    pub fn cancel_project_manifest(&mut self) {
        self.project_manifest_upload.cancel();
    }

    /// Decode the manifest embedded in a self-contained `RustyEra` project file.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the file is corrupt or uses an unsupported version.
    #[wasm_bindgen(js_name = projectFileManifest)]
    pub fn project_file_manifest(&self, bytes: &js_sys::Uint8Array) -> Result<JsValue, JsValue> {
        to_js(
            self.inner
                .project_file_manifest(&bytes.to_vec())
                .map_err(js_error)?,
        )
    }

    /// Inspect bounded embedded payload identities without changing the active session.
    ///
    /// # Errors
    /// Returns an error for an invalid or oversized complete project export.
    #[wasm_bindgen(js_name = projectFileIdentity)]
    pub fn project_file_identity(&self, bytes: &js_sys::Uint8Array) -> Result<JsValue, JsValue> {
        to_js(era_web_bridge::inspect_project_file_identity(&bytes.to_vec()).map_err(js_error)?)
    }

    /// Begin receiving one project file in bounded chunks.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when another upload is active, the file exceeds the negotiated
    /// transfer limit, or memory for the required retained sections cannot be reserved.
    #[wasm_bindgen(js_name = beginProjectFile)]
    pub fn begin_project_file(&mut self, total_bytes: u32) -> Result<(), JsValue> {
        let expected_len = usize::try_from(total_bytes)
            .map_err(|_| js_error("project file size is unsupported on this platform"))?;
        let maximum_len =
            usize::try_from(self.inner.maximum_transfer_bytes()).unwrap_or(usize::MAX);
        self.project_file_upload
            .begin(expected_len, maximum_len)
            .map_err(js_error)
    }

    /// Copy one bounded JavaScript chunk into the active WASM-owned project-file buffer.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when no upload is active or the chunk exceeds the declared size.
    #[wasm_bindgen(js_name = appendProjectFile)]
    pub fn append_project_file(&mut self, chunk: &js_sys::Uint8Array) -> Result<(), JsValue> {
        let chunk_len = usize::try_from(chunk.length())
            .map_err(|_| js_error("project file chunk size is unsupported"))?;
        let destination = self
            .project_file_upload
            .append_destination(chunk_len)
            .map_err(js_error)?;
        chunk.copy_to(destination);
        Ok(())
    }

    /// Decode and load the completed WASM-owned project-file buffer without another full copy.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the upload is absent or incomplete, or the project file is
    /// corrupt, unsupported, or cannot be staged for the runtime.
    #[wasm_bindgen(js_name = finishProjectFile)]
    pub fn finish_project_file(&mut self) -> Result<JsValue, JsValue> {
        let bytes = self.project_file_upload.finish().map_err(js_error)?;
        stage_project_file_bytes(self, &bytes)
    }

    /// Decode and submit the completed project-file upload as authoritative source.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the upload is incomplete or its source cannot be decoded.
    #[wasm_bindgen(js_name = finishProjectFileSource)]
    pub fn finish_project_file_source(&mut self) -> Result<JsValue, JsValue> {
        let bytes = self.project_file_upload.finish().map_err(js_error)?;
        stage_project_file_source(self, &bytes)
    }

    /// Load one complete transferred project-file buffer on unconstrained browsers.
    ///
    /// Unconstrained engines can read the selected file efficiently and transfer the JavaScript
    /// buffer to the Worker. Constrained browsers retain the acknowledged upload API
    /// above so they never hold the complete file in both JavaScript and WebAssembly while reading.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the project file is corrupt, unsupported, or cannot be
    /// staged for the runtime.
    #[wasm_bindgen(js_name = loadProjectFileBytes)]
    pub fn load_project_file_bytes(
        &mut self,
        bytes: &js_sys::Uint8Array,
    ) -> Result<JsValue, JsValue> {
        stage_project_file_bytes(self, &bytes.to_vec())
    }

    /// Decode and submit a complete project file as authoritative source after cache rejection.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the project file is invalid or cannot be submitted.
    #[wasm_bindgen(js_name = loadProjectFileSourceBytes)]
    pub fn load_project_file_source_bytes(
        &mut self,
        bytes: &js_sys::Uint8Array,
    ) -> Result<JsValue, JsValue> {
        stage_project_file_source(self, &bytes.to_vec())
    }

    /// Load a portable project's source/resource identity with a separately persisted cache.
    ///
    /// The project file remains authoritative for identity and resources. Runtime validates the
    /// opaque sidecar against that identity and its current cache contract before accepting it.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the project file or sidecar cannot be staged.
    #[wasm_bindgen(js_name = loadProjectFileWithCompiledCacheBytes)]
    pub fn load_project_file_with_compiled_cache_bytes(
        &mut self,
        project_file: &js_sys::Uint8Array,
        compiled_cache: &js_sys::Uint8Array,
    ) -> Result<JsValue, JsValue> {
        stage_project_file_with_compiled_cache(
            self,
            &project_file.to_vec(),
            &compiled_cache.to_vec(),
        )
    }

    /// Copy one embedded project resource (or a bounded prefix) to JavaScript on demand.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the resource is unknown.
    #[wasm_bindgen(js_name = readProjectFileResource)]
    pub fn read_project_file_resource(
        &self,
        relative_path: &str,
        maximum_bytes: Option<u32>,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let key = relative_path.replace('\\', "/").to_lowercase();
        let bytes = self.project_file_resources.get(&key).ok_or_else(|| {
            js_error(format!(
                "unknown packaged project resource: {relative_path}"
            ))
        })?;
        let length = maximum_bytes
            .and_then(|value| usize::try_from(value).ok())
            .map_or(bytes.len(), |value| value.min(bytes.len()));
        Ok(js_sys::Uint8Array::from(&bytes[..length]))
    }

    /// Discard an incomplete project-file upload after a browser read or transfer failure.
    #[wasm_bindgen(js_name = cancelProjectFile)]
    pub fn cancel_project_file(&mut self) {
        self.project_file_upload.cancel();
    }

    /// Prepare a compact append-only update for a project file's embedded configuration.
    ///
    /// The returned byte array starts with a little-endian `u64` truncation offset and is
    /// followed by the journal record to append.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the project, optimistic-lock digest, or TOML is invalid.
    #[wasm_bindgen(js_name = prepareProjectConfigurationUpdate)]
    pub fn prepare_project_configuration_update(
        &self,
        project_file: &js_sys::Uint8Array,
        expected_digest: &js_sys::Uint8Array,
        contents: &str,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let project_file = project_file.to_vec();
        let update = era_runtime::prepare_project_configuration_update(
            &project_file,
            usize::try_from(self.inner.maximum_transfer_bytes()).unwrap_or(usize::MAX),
            &expected_digest.to_vec(),
            contents,
        )
        .map_err(js_error)?;
        let mut encoded = Vec::with_capacity(8 + update.append.len());
        encoded.extend_from_slice(&update.truncate_to.to_le_bytes());
        encoded.extend_from_slice(&update.append);
        Ok(js_sys::Uint8Array::from(encoded.as_slice()))
    }

    /// Return the active project's selectable traditional-save slot count.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error until a project has compiled successfully.
    #[wasm_bindgen(js_name = traditionalSaveSlotCount)]
    pub fn traditional_save_slot_count(&self) -> Result<u32, JsValue> {
        self.inner.traditional_save_slot_count().map_err(js_error)
    }

    /// Validate a traditional save against the active project without changing game state.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the save is malformed or incompatible.
    #[wasm_bindgen(js_name = inspectTraditionalSave)]
    pub fn inspect_traditional_save(&self, bytes: &js_sys::Uint8Array) -> Result<JsValue, JsValue> {
        to_js(
            self.inner
                .inspect_traditional_save(&bytes.to_vec())
                .map_err(js_error)?,
        )
    }

    /// Import a compiled project cache after validating its lightweight manifest identity.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the manifest, cache, or runtime transfer is invalid.
    #[wasm_bindgen(js_name = loadProjectWithCompiledCache)]
    pub fn load_project_with_compiled_cache(
        &mut self,
        manifest: JsValue,
        cache: &js_sys::Uint8Array,
    ) -> Result<JsValue, JsValue> {
        let manifest: ProjectManifest = from_js(manifest)?;
        let identity = project_identity(&manifest).map_err(js_error)?;
        let message_id = self
            .inner
            .load_project_with_compiled_cache(identity, cache.to_vec())
            .map_err(js_error)?;
        self.project_file_resources.track_replacement(message_id);
        to_js(message_id)
    }

    /// Import a compiled cache using the browser's binary identity manifest.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the binary manifest, cache, or runtime transfer is invalid.
    #[wasm_bindgen(js_name = loadProjectWithCompiledCacheBinary)]
    pub fn load_project_with_compiled_cache_binary(
        &mut self,
        manifest: &js_sys::Uint8Array,
        cache: &js_sys::Uint8Array,
    ) -> Result<JsValue, JsValue> {
        let manifest = decode_browser_manifest(&manifest.to_vec()).map_err(js_error)?;
        let identity = project_identity(&manifest).map_err(js_error)?;
        let message_id = self
            .inner
            .load_project_with_compiled_cache(identity, cache.to_vec())
            .map_err(js_error)?;
        self.project_file_resources.track_replacement(message_id);
        to_js(message_id)
    }

    /// Drive one bounded worker slice and return all typed events.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when runtime driving or event projection fails.
    pub fn pump(
        &mut self,
        maximum_vm_instructions: u32,
        maximum_runtime_transitions: u32,
    ) -> Result<JsValue, JsValue> {
        let batch = self
            .inner
            .pump_quiet(
                RuntimeDriveBudget {
                    maximum_vm_instructions: u64::from(maximum_vm_instructions),
                    maximum_runtime_transitions,
                },
                FRONTEND_PUMP_MAXIMUM_QUIET_SLICES,
            )
            .map_err(js_error)?;
        for event in &batch.events {
            if event
                .message
                .get("type")
                .and_then(serde_json::Value::as_str)
                != Some("project_load_report")
            {
                continue;
            }
            let success = event
                .message
                .get("value")
                .and_then(|value| value.get("success"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            self.project_file_resources
                .complete_replacement(event.message_id, success);
        }
        to_js(WasmPumpBatch {
            batch,
            memory_bytes: wasm_memory_bytes(),
        })
    }
}

fn from_js<T: DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(js_error)
}

fn to_js(value: impl serde::Serialize) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_large_number_types_as_bigints(true);
    serde::Serialize::serialize(&value, &serializer).map_err(js_error)
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn copy_uint8_array(bytes: &js_sys::Uint8Array) -> Result<Vec<u8>, String> {
    let length = usize::try_from(bytes.length())
        .map_err(|_| "browser project payload size is unsupported".to_owned())?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(length)
        .map_err(|error| format!("failed to reserve browser project payload: {error}"))?;
    result.resize(length, 0);
    bytes.copy_to(&mut result);
    Ok(result)
}

fn wasm_memory_bytes() -> u32 {
    use wasm_bindgen::JsCast;

    let memory = wasm_bindgen::memory().unchecked_into::<js_sys::WebAssembly::Memory>();
    memory
        .buffer()
        .dyn_into::<js_sys::ArrayBuffer>()
        .map_or(0, |buffer| buffer.byte_length())
}
