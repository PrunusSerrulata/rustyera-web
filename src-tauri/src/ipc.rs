use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value};

const MAXIMUM_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
const MINIMUM_SAFE_JAVASCRIPT_INTEGER: i64 = -9_007_199_254_740_991;
const IPC_INTEGER_TAG: &str = "$rustyeraInteger";

pub(crate) fn encode_value<T: Serialize>(value: &T) -> Result<Value, String> {
    let mut value = serde_json::to_value(value)
        .map_err(|error| format!("cannot encode IPC response: {error}"))?;
    tag_unsafe_integers(&mut value);
    Ok(value)
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
}
