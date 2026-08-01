//! WebAssembly bindings for the shared `RustyEra` web session bridge.

use era_debug_protocol::DebugMessage;
use era_runtime::{ProjectProgressReporter, RuntimeDriveBudget};
use era_runtime_protocol::{ProjectManifest, RuntimeMessage};
use era_web_bridge::{WebSession, WebSessionOptions, project_identity};
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
                .load_project_with_compiled_cache(identity, &cache.to_vec())
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
            .pump(RuntimeDriveBudget {
                maximum_vm_instructions: u64::from(maximum_vm_instructions),
                maximum_runtime_transitions,
            })
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
