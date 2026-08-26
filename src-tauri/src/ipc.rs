use base64::Engine as _;
use era_web_bridge::{PumpBatch, WebEvent};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde_json::{Map, Number, Value};
use tauri::ipc::Response;

mod safe;

use safe::{
    IPC_BYTES_TAG, IPC_INTEGER_TAG, SafeBytes, SafeJson, SafeU64, is_unsafe_javascript_integer,
};

pub(crate) fn encode_value<T: Serialize>(value: &T) -> Result<Value, String> {
    let mut value = serde_json::to_value(value)
        .map_err(|error| format!("cannot encode IPC response: {error}"))?;
    tag_unsafe_integers(&mut value);
    Ok(value)
}

pub(crate) fn encode_pump_response(value: &PumpBatch) -> Result<Response, String> {
    let bytes = serde_json::to_vec(&SafePump(value))
        .map_err(|error| format!("cannot encode binary IPC response: {error}"))?;
    Ok(Response::new(bytes))
}

pub(crate) fn encode_submitted_pump_response(
    message_id: u64,
    value: &PumpBatch,
) -> Result<Response, String> {
    let bytes = serde_json::to_vec(&SafeSubmittedPump { message_id, value })
        .map_err(|error| format!("cannot encode binary IPC response: {error}"))?;
    Ok(Response::new(bytes))
}

struct SafeSubmittedPump<'a> {
    message_id: u64,
    value: &'a PumpBatch,
}

impl Serialize for SafeSubmittedPump<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("submittedMessageId", &SafeU64(self.message_id))?;
        serialize_pump_fields(&mut map, self.value)?;
        map.end()
    }
}

struct SafePump<'a>(&'a PumpBatch);

impl Serialize for SafePump<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        serialize_pump_fields(&mut map, self.0)?;
        map.end()
    }
}

fn serialize_pump_fields<S>(map: &mut S, value: &PumpBatch) -> Result<(), S::Error>
where
    S: SerializeMap,
{
    map.serialize_entry("state", &value.state)?;
    map.serialize_entry("vmInstructions", &SafeU64(value.vm_instructions))?;
    map.serialize_entry("runtimeTransitions", &value.runtime_transitions)?;
    map.serialize_entry("events", &SafeEvents(&value.events))?;
    Ok(())
}

struct SafeEvents<'a>(&'a [WebEvent]);

impl Serialize for SafeEvents<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for event in self.0 {
            sequence.serialize_element(&SafeEvent(event))?;
        }
        sequence.end()
    }
}

struct SafeEvent<'a>(&'a WebEvent);

impl Serialize for SafeEvent<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map =
            serializer.serialize_map(Some(if self.0.data_bytes.is_some() { 7 } else { 6 }))?;
        map.serialize_entry("channel", &self.0.channel)?;
        map.serialize_entry("sequence", &SafeU64(self.0.sequence))?;
        map.serialize_entry("messageId", &SafeU64(self.0.message_id))?;
        map.serialize_entry("correlationId", &self.0.correlation_id.map(SafeU64))?;
        map.serialize_entry("epoch", &self.0.epoch.map(SafeU64))?;
        map.serialize_entry("message", &SafeJson(&self.0.message))?;
        if let Some(bytes) = &self.0.data_bytes {
            map.serialize_entry("dataBytes", &SafeBytes(&bytes.0))?;
        }
        map.end()
    }
}

pub(crate) fn decode_value<T: DeserializeOwned>(mut value: Value) -> Result<T, String> {
    untag_unsafe_integers(&mut value)?;
    serde_json::from_value(value).map_err(|error| format!("cannot decode IPC request: {error}"))
}

pub(crate) fn decode_bytes(value: Value) -> Result<Vec<u8>, String> {
    if let Some(encoded) = value
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get(IPC_BYTES_TAG))
        .and_then(Value::as_str)
    {
        return base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("cannot decode IPC bytes: {error}"));
    }
    serde_json::from_value(value).map_err(|error| format!("cannot decode IPC bytes: {error}"))
}

fn tag_unsafe_integers(value: &mut Value) {
    match value {
        Value::Number(number) if is_unsafe_javascript_integer(number) => {
            let mut tagged = Map::new();
            tagged.insert(
                IPC_INTEGER_TAG.to_owned(),
                Value::String(number.to_string()),
            );
            *value = Value::Object(tagged);
        }
        Value::Array(items) => items.iter_mut().for_each(tag_unsafe_integers),
        Value::Object(fields) => fields.values_mut().for_each(tag_unsafe_integers),
        _ => {}
    }
}

fn untag_unsafe_integers(value: &mut Value) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for item in items {
                untag_unsafe_integers(item)?;
            }
        }
        Value::Object(fields) if fields.len() == 1 && fields.contains_key(IPC_INTEGER_TAG) => {
            let encoded = fields
                .get(IPC_INTEGER_TAG)
                .and_then(Value::as_str)
                .ok_or_else(|| "invalid tagged IPC integer".to_owned())?;
            *value = Value::Number(
                encoded
                    .parse::<Number>()
                    .map_err(|error| format!("invalid tagged IPC integer: {error}"))?,
            );
        }
        Value::Object(fields) => {
            for field in fields.values_mut() {
                untag_unsafe_integers(field)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use era_web_bridge::{PumpBatch, WebChannel, WebDriveState, WebEvent};

    use super::*;
    use crate::ipc::safe::MAXIMUM_SAFE_JAVASCRIPT_INTEGER;

    #[test]
    fn round_trips_integers_outside_javascript_safe_range() {
        let original = serde_json::json!({
            "positive": 4_919_414_282_687_566_401_u64,
            "negative": -9_007_199_254_740_992_i64,
            "safe": MAXIMUM_SAFE_JAVASCRIPT_INTEGER,
        });

        let encoded = encode_value(&original).unwrap();
        assert_eq!(encoded["positive"][IPC_INTEGER_TAG], "4919414282687566401");
        assert_eq!(encoded["negative"][IPC_INTEGER_TAG], "-9007199254740992");
        assert_eq!(encoded["safe"], MAXIMUM_SAFE_JAVASCRIPT_INTEGER);
        assert_eq!(decode_value::<Value>(encoded).unwrap(), original);
    }

    #[test]
    fn pump_serializer_tags_outer_and_nested_unsafe_integers_without_reprojection() {
        let batch = PumpBatch {
            state: WebDriveState::OutputReady,
            vm_instructions: MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 1,
            runtime_transitions: 1,
            cooperative_background_work: false,
            events: vec![WebEvent {
                channel: WebChannel::Runtime,
                sequence: 2,
                message_id: 3,
                correlation_id: None,
                epoch: None,
                message: serde_json::json!({
                    "type": "test",
                    "value": MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 2,
                }),
                data_bytes: None,
            }],
        };

        let encoded: Value =
            serde_json::from_slice(&serde_json::to_vec(&SafePump(&batch)).unwrap()).unwrap();
        assert_eq!(
            encoded["vmInstructions"][IPC_INTEGER_TAG],
            (MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 1).to_string()
        );
        assert_eq!(
            encoded["events"][0]["message"]["value"][IPC_INTEGER_TAG],
            (MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 2).to_string()
        );
    }

    #[test]
    fn submitted_pump_serializer_tags_the_message_id() {
        let batch = PumpBatch {
            state: WebDriveState::Idle,
            vm_instructions: 1,
            runtime_transitions: 2,
            cooperative_background_work: false,
            events: Vec::new(),
        };
        let encoded: Value = serde_json::from_slice(
            &serde_json::to_vec(&SafeSubmittedPump {
                message_id: MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 1,
                value: &batch,
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            encoded["submittedMessageId"][IPC_INTEGER_TAG],
            (MAXIMUM_SAFE_JAVASCRIPT_INTEGER + 1).to_string()
        );
        assert_eq!(encoded["state"], "idle");
        assert_eq!(encoded["runtimeTransitions"], 2);
    }

    #[test]
    fn pump_serializer_and_command_decoder_use_tagged_binary_bytes() {
        let batch = PumpBatch {
            state: WebDriveState::OutputReady,
            vm_instructions: 0,
            runtime_transitions: 1,
            cooperative_background_work: false,
            events: vec![WebEvent {
                channel: WebChannel::Runtime,
                sequence: 2,
                message_id: 3,
                correlation_id: None,
                epoch: None,
                message: serde_json::json!({
                    "type": "state_export_chunk",
                    "value": { "data": [] },
                }),
                data_bytes: Some(era_web_bridge::WebBytes(vec![0, 1, 127, 255])),
            }],
        };

        let encoded: Value =
            serde_json::from_slice(&serde_json::to_vec(&SafePump(&batch)).unwrap()).unwrap();
        let tagged = encoded["events"][0]["dataBytes"].clone();
        assert_eq!(tagged[IPC_BYTES_TAG], "AAF//w==");
        assert_eq!(decode_bytes(tagged).unwrap(), vec![0, 1, 127, 255]);
    }
}
