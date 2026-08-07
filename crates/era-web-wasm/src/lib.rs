//! WebAssembly bindings for the shared `RustyEra` web session bridge.

use era_debug_protocol::DebugMessage;
use era_runtime::{ProjectProgressReporter, RuntimeDriveBudget};
use era_runtime_protocol::{
    FileCategory, FilePayload, ProjectManifest, ProtocolBytes, RuntimeMessage, SubmittedFile,
};
use era_web_bridge::{
    FRONTEND_PUMP_MAXIMUM_QUIET_SLICES, WebSession, WebSessionOptions, project_identity,
};
use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmProjectProgress {
    stage: era_runtime::ProjectProgressStage,
    completed: u32,
    total: u32,
}

#[wasm_bindgen]
pub struct WasmRuntime {
    inner: WebSession,
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
        if let Some(progress_callback) = progress_callback {
            inner.set_project_progress_reporter(Some(ProjectProgressReporter::new(
                move |progress| {
                    if let Ok(value) = to_js(WasmProjectProgress {
                        stage: progress.stage,
                        completed: u32::try_from(progress.completed).unwrap_or(u32::MAX),
                        total: u32::try_from(progress.total).unwrap_or(u32::MAX),
                    }) {
                        let _ = progress_callback.call1(&JsValue::UNDEFINED, &value);
                    }
                },
            )));
        }
        Ok(Self { inner })
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
    use super::decode_browser_manifest;
    use era_runtime_protocol::{FileCategory, FilePayload};

    #[test]
    fn browser_manifest_binary_decodes_text_and_resource_payloads() {
        let mut bytes = b"RERMAN01".to_vec();
        bytes.extend_from_slice(&7_u64.to_le_bytes());
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        append_file(&mut bytes, 2, b"main.erb", 0, b"@MAIN\nRETURN\n", &[3; 32]);
        append_file(&mut bytes, 4, b"resources/a.png", 1, &[1, 2, 3], &[4; 32]);

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
