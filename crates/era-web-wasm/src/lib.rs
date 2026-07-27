//! WebAssembly bindings for the shared `RustyEra` web session bridge.

use era_debug_protocol::DebugMessage;
use era_runtime::RuntimeDriveBudget;
use era_runtime_protocol::{ProjectManifest, RuntimeMessage};
use era_web_bridge::{WebSession, WebSessionOptions};
use wasm_bindgen::prelude::*;

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
    pub fn new(options: JsValue) -> Result<WasmRuntime, JsValue> {
        let options = if options.is_null() || options.is_undefined() {
            WebSessionOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options).map_err(js_error)?
        };
        Ok(Self {
            inner: WebSession::new(options).map_err(js_error)?,
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
        let message: RuntimeMessage = serde_wasm_bindgen::from_value(message).map_err(js_error)?;
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
        let message: DebugMessage = serde_wasm_bindgen::from_value(message).map_err(js_error)?;
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
        let manifest: ProjectManifest =
            serde_wasm_bindgen::from_value(manifest).map_err(js_error)?;
        to_js(self.inner.load_project(manifest).map_err(js_error)?)
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

fn to_js(value: impl serde::Serialize) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_large_number_types_as_bigints(true);
    serde::Serialize::serialize(&value, &serializer).map_err(js_error)
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}
