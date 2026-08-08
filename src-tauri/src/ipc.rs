use era_web_bridge::{PumpBatch, WebEvent};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde_json::{Map, Number, Value};
use tauri::ipc::Response;

const MAXIMUM_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
const MINIMUM_SAFE_JAVASCRIPT_INTEGER: i64 = -9_007_199_254_740_991;
const IPC_INTEGER_TAG: &str = "$rustyeraInteger";

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

struct SafePump<'a>(&'a PumpBatch);

impl Serialize for SafePump<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("state", &self.0.state)?;
        map.serialize_entry("vmInstructions", &SafeU64(self.0.vm_instructions))?;
        map.serialize_entry("runtimeTransitions", &self.0.runtime_transitions)?;
        map.serialize_entry("events", &SafeEvents(&self.0.events))?;
        map.end()
    }
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
        let mut map = serializer.serialize_map(Some(6))?;
        map.serialize_entry("channel", &self.0.channel)?;
        map.serialize_entry("sequence", &SafeU64(self.0.sequence))?;
        map.serialize_entry("messageId", &SafeU64(self.0.message_id))?;
        map.serialize_entry("correlationId", &self.0.correlation_id.map(SafeU64))?;
        map.serialize_entry("epoch", &self.0.epoch.map(SafeU64))?;
        map.serialize_entry("message", &SafeJson(&self.0.message))?;
        map.end()
    }
}

struct SafeU64(u64);

impl Serialize for SafeU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.0 <= MAXIMUM_SAFE_JAVASCRIPT_INTEGER {
            serializer.serialize_u64(self.0)
        } else {
            serialize_tagged_integer(serializer, &self.0.to_string())
        }
    }
}

struct SafeJson<'a>(&'a Value);

impl Serialize for SafeJson<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self.0 {
            Value::Null => serializer.serialize_none(),
            Value::Bool(value) => serializer.serialize_bool(*value),
            Value::Number(value) if is_unsafe_javascript_integer(value) => {
                serialize_tagged_integer(serializer, &value.to_string())
            }
            Value::Number(value) => value.serialize(serializer),
            Value::String(value) => serializer.serialize_str(value),
            Value::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&SafeJson(value))?;
                }
                sequence.end()
            }
            Value::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, &SafeJson(value))?;
                }
                map.end()
            }
        }
    }
}

fn serialize_tagged_integer<S>(serializer: S, value: &str) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut map = serializer.serialize_map(Some(1))?;
    map.serialize_entry(IPC_INTEGER_TAG, value)?;
    map.end()
}

pub(crate) fn decode_value<T: DeserializeOwned>(mut value: Value) -> Result<T, String> {
    untag_unsafe_integers(&mut value)?;
    serde_json::from_value(value).map_err(|error| format!("cannot decode IPC request: {error}"))
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

fn is_unsafe_javascript_integer(number: &Number) -> bool {
    number
        .as_u64()
        .is_some_and(|value| value > MAXIMUM_SAFE_JAVASCRIPT_INTEGER)
        || number
            .as_i64()
            .is_some_and(|value| value < MINIMUM_SAFE_JAVASCRIPT_INTEGER)
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
}
