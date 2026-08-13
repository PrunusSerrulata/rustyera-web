use base64::Engine as _;
use serde::Serialize;
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde_json::{Number, Value};

pub(super) const MAXIMUM_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
const MINIMUM_SAFE_JAVASCRIPT_INTEGER: i64 = -9_007_199_254_740_991;
pub(super) const IPC_INTEGER_TAG: &str = "$rustyeraInteger";
pub(super) const IPC_BYTES_TAG: &str = "$rustyeraBytes";

pub(super) struct SafeBytes<'a>(pub &'a [u8]);

impl Serialize for SafeBytes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = base64::engine::general_purpose::STANDARD.encode(self.0);
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(IPC_BYTES_TAG, &encoded)?;
        map.end()
    }
}

pub(super) struct SafeU64(pub u64);

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

pub(super) struct SafeJson<'a>(pub &'a Value);

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
                    sequence.serialize_element(&Self(value))?;
                }
                sequence.end()
            }
            Value::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, &Self(value))?;
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

pub(super) fn is_unsafe_javascript_integer(number: &Number) -> bool {
    number
        .as_u64()
        .is_some_and(|value| value > MAXIMUM_SAFE_JAVASCRIPT_INTEGER)
        || number
            .as_i64()
            .is_some_and(|value| value < MINIMUM_SAFE_JAVASCRIPT_INTEGER)
}
