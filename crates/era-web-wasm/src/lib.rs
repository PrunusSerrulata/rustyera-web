//! WebAssembly bindings for the shared `RustyEra` web session bridge.

use era_debug_protocol::DebugMessage;
use era_runtime::{ProjectProgressReporter, RuntimeDriveBudget};
use era_runtime_protocol::{
    ExternalResource, FileCategory, FilePayload, ImageMetadataResponse, ProjectManifest,
    ProtocolBytes, RuntimeMessage, SubmittedFile,
};
use era_web_bridge::{
    FRONTEND_PUMP_MAXIMUM_QUIET_SLICES, WebSession, WebSessionOptions, project_identity,
};
use serde::de::DeserializeOwned;
use std::time::Duration;
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmProjectProgress {
    stage: era_runtime::ProjectProgressStage,
    completed: u32,
    total: u32,
    elapsed_ms: f64,
}

#[wasm_bindgen]
pub struct WasmRuntime {
    inner: WebSession,
    project_file_upload: ProjectFileUpload,
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
            project_file_upload: ProjectFileUpload::default(),
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
        to_js(self.inner.load_project(manifest).map_err(js_error)?)
    }

    /// Decode and submit the browser's compact binary manifest transport.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when the transport is malformed or cannot be queued.
    #[wasm_bindgen(js_name = loadProjectBinary)]
    pub fn load_project_binary(&mut self, bytes: &js_sys::Uint8Array) -> Result<JsValue, JsValue> {
        let manifest = decode_browser_manifest(&bytes.to_vec()).map_err(js_error)?;
        to_js(self.inner.load_project(manifest).map_err(js_error)?)
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

    /// Reserve the WASM-owned buffer used to receive one project file in bounded chunks.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error when another upload is active, the file exceeds the negotiated
    /// transfer limit, or memory for the declared file size cannot be reserved.
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
        let manifest = self.inner.project_file_manifest(&bytes).map_err(js_error)?;
        let identity = project_identity(&manifest).map_err(js_error)?;
        let storage_key = blake3::hash(&bytes).to_hex().to_string();
        self.inner
            .load_project_with_compiled_cache(identity, bytes)
            .map_err(js_error)?;
        to_js(LoadedProjectFile {
            manifest,
            storage_key,
        })
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
        to_js(
            self.inner
                .load_project_with_compiled_cache(identity, cache.to_vec())
                .map_err(js_error)?,
        )
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
        to_js(
            self.inner
                .load_project_with_compiled_cache(identity, cache.to_vec())
                .map_err(js_error)?,
        )
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
        to_js(batch)
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

const BROWSER_MANIFEST_MAGIC: &[u8; 8] = b"RERMAN01";

fn decode_browser_manifest(bytes: &[u8]) -> Result<ProjectManifest, String> {
    let mut reader = BinaryReader::new(bytes);
    if reader.read_exact(BROWSER_MANIFEST_MAGIC.len())? != BROWSER_MANIFEST_MAGIC {
        return Err("browser project manifest has an invalid header".into());
    }
    let project_revision = reader.read_u64()?;
    let file_count = usize::try_from(reader.read_u32()?)
        .map_err(|_| "browser project manifest file count is too large")?;
    if file_count > bytes.len() / 15 {
        return Err("browser project manifest file count exceeds its encoded size".into());
    }
    let mut files = Vec::new();
    files
        .try_reserve_exact(file_count)
        .map_err(|_| "browser project manifest allocation failed")?;
    for _ in 0..file_count {
        let category = decode_file_category(reader.read_u8()?)?;
        let path_length =
            usize::try_from(reader.read_u32()?).map_err(|_| "browser project path is too large")?;
        let payload_tag = reader.read_u8()?;
        let payload_length = usize::try_from(reader.read_u64()?)
            .map_err(|_| "browser project payload is too large")?;
        let hash_length = usize::from(reader.read_u8()?);
        if !matches!(hash_length, 0 | 32) {
            return Err("browser project content hash must be empty or 32 bytes".into());
        }
        let relative_path = String::from_utf8(reader.read_exact(path_length)?.to_vec())
            .map_err(|_| "browser project path is not UTF-8")?;
        let payload_bytes = reader.read_exact(payload_length)?;
        let payload = match payload_tag {
            0 => FilePayload::Utf8(
                String::from_utf8(payload_bytes.to_vec())
                    .map_err(|_| "browser project text payload is not UTF-8")?,
            ),
            1 => FilePayload::Bytes(ProtocolBytes::new(payload_bytes.to_vec())),
            2 => decode_external_resource(payload_bytes)?,
            _ => return Err("browser project payload tag is invalid".into()),
        };
        let content_hash = (hash_length != 0)
            .then(|| {
                reader
                    .read_exact(hash_length)
                    .map(|hash| ProtocolBytes::new(hash.to_vec()))
            })
            .transpose()?;
        files.push(SubmittedFile {
            relative_path,
            category,
            payload,
            content_hash,
        });
    }
    if !reader.is_empty() {
        return Err("browser project manifest has trailing bytes".into());
    }
    Ok(ProjectManifest {
        project_revision,
        files,
    })
}

fn decode_external_resource(bytes: &[u8]) -> Result<FilePayload, String> {
    if bytes.len() != 18 {
        return Err("browser external resource descriptor has an invalid size".into());
    }
    let byte_length = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let image_metadata = if bytes[16] == 0xff {
        None
    } else {
        let format = match bytes[16] {
            0 => "png",
            1 => "bmp",
            2 => "gif",
            3 => "jpeg",
            4 => "webp",
            _ => return Err("browser external resource image format is invalid".into()),
        };
        let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        if width == 0 || height == 0 || bytes[17] > 1 {
            return Err("browser external resource image metadata is invalid".into());
        }
        Some(ImageMetadataResponse {
            width,
            height,
            format: format.to_owned(),
            animated: bytes[17] != 0,
        })
    };
    Ok(FilePayload::ExternalResource(ExternalResource {
        byte_length,
        image_metadata,
    }))
}

fn decode_file_category(value: u8) -> Result<FileCategory, String> {
    match value {
        0 => Ok(FileCategory::Csv),
        1 => Ok(FileCategory::Erh),
        2 => Ok(FileCategory::Erb),
        3 => Ok(FileCategory::ResourceManifest),
        4 => Ok(FileCategory::Resource),
        5 => Ok(FileCategory::Configuration),
        _ => Err("browser project file category is invalid".into()),
    }
}

struct BinaryReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BinaryReader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_exact(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or("browser project manifest length overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("browser project manifest is truncated")?;
        self.offset = end;
        Ok(value)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        self.read_exact(1).map(|bytes| bytes[0])
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        self.read_exact(4).map(|bytes| {
            u32::from_le_bytes(bytes.try_into().expect("four-byte slice was requested"))
        })
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        self.read_exact(8).map(|bytes| {
            u64::from_le_bytes(bytes.try_into().expect("eight-byte slice was requested"))
        })
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{ProjectFileUpload, decode_browser_manifest};
    use era_runtime_protocol::{FileCategory, FilePayload};

    #[test]
    fn browser_manifest_binary_decodes_text_and_resource_payloads() {
        let mut bytes = b"RERMAN01".to_vec();
        bytes.extend_from_slice(&7_u64.to_le_bytes());
        bytes.extend_from_slice(&3_u32.to_le_bytes());
        append_file(&mut bytes, 2, b"main.erb", 0, b"@MAIN\nRETURN\n", &[3; 32]);
        append_file(&mut bytes, 4, b"resources/a.png", 1, &[1, 2, 3], &[4; 32]);
        let mut external = Vec::new();
        external.extend_from_slice(&1234_u64.to_le_bytes());
        external.extend_from_slice(&640_u32.to_le_bytes());
        external.extend_from_slice(&480_u32.to_le_bytes());
        external.extend_from_slice(&[0, 0]);
        append_file(&mut bytes, 4, b"resources/b.png", 2, &external, &[5; 32]);

        let manifest = decode_browser_manifest(&bytes).unwrap();

        assert_eq!(manifest.project_revision, 7);
        assert_eq!(manifest.files[0].category, FileCategory::Erb);
        assert!(
            matches!(&manifest.files[0].payload, FilePayload::Utf8(text) if text.contains("MAIN"))
        );
        assert!(
            matches!(&manifest.files[1].payload, FilePayload::Bytes(value) if value.as_slice() == [1, 2, 3])
        );
        assert_eq!(
            manifest.files[1].content_hash.as_ref().unwrap().as_slice(),
            [4; 32]
        );
        assert!(matches!(
            &manifest.files[2].payload,
            FilePayload::ExternalResource(resource)
                if resource.byte_length == 1234
                    && resource.image_metadata.as_ref().is_some_and(|value| value.width == 640)
        ));
    }

    #[test]
    fn project_file_upload_enforces_bounds_completion_and_reuse() {
        let mut upload = ProjectFileUpload::default();
        assert!(upload.finish().unwrap_err().contains("no project file"));

        upload.begin(3, 3).unwrap();
        assert!(upload.begin(3, 3).unwrap_err().contains("already active"));
        upload
            .append_destination(2)
            .unwrap()
            .copy_from_slice(&[1, 2]);
        assert!(
            upload
                .append_destination(2)
                .unwrap_err()
                .contains("declared size")
        );
        assert!(upload.finish().unwrap_err().contains("received 2 of 3"));
        upload.append_destination(1).unwrap().copy_from_slice(&[3]);
        assert_eq!(upload.finish().unwrap(), [1, 2, 3]);

        upload.begin(2, 3).unwrap();
        upload.append_destination(1).unwrap()[0] = 9;
        upload.cancel();
        upload.begin(1, 3).unwrap();
        upload.append_destination(1).unwrap()[0] = 4;
        assert_eq!(upload.finish().unwrap(), [4]);
    }

    #[test]
    fn project_file_upload_rejects_a_declared_size_above_the_limit() {
        let mut upload = ProjectFileUpload::default();

        assert!(upload.begin(4, 3).unwrap_err().contains("transfer limit"));
        upload.begin(3, 3).unwrap();
    }

    fn append_file(
        output: &mut Vec<u8>,
        category: u8,
        path: &[u8],
        payload_tag: u8,
        payload: &[u8],
        hash: &[u8],
    ) {
        output.push(category);
        output.extend_from_slice(&u32::try_from(path.len()).unwrap().to_le_bytes());
        output.push(payload_tag);
        output.extend_from_slice(&u64::try_from(payload.len()).unwrap().to_le_bytes());
        output.push(u8::try_from(hash.len()).unwrap());
        output.extend_from_slice(path);
        output.extend_from_slice(payload);
        output.extend_from_slice(hash);
    }
}
