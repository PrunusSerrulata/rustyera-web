//! Passive storage evidence, compiled only into WebDriver/test hosts.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use era_runtime_protocol::{StorageOperation, StorageRequest, StorageResponse, StorageResult};
use serde_json::{Value, json};

const MAXIMUM_BYTES: usize = 8 * 1024 * 1024;
static SINK: OnceLock<Mutex<Result<Sink, String>>> = OnceLock::new();

struct Sink {
    file: File,
    bytes: usize,
    sequence: u64,
    failed: bool,
}

pub(super) struct Pending {
    context: Value,
    request: Value,
}

impl Pending {
    pub(super) fn begin(request: &StorageRequest, project: &Path, save: &Path) -> Option<Self> {
        std::env::var_os("RUSTYERA_TEST_NATIVE_STORAGE_TRACE")?;
        Some(Self {
            context: json!({"process_id": std::process::id(), "project_root": project, "save_root": save}),
            request: request_value(request),
        })
    }

    pub(super) fn finish(self, response: &StorageResponse) {
        let result = SINK.get_or_init(|| {
            Mutex::new((|| {
                let path = std::env::var_os("RUSTYERA_TEST_NATIVE_STORAGE_TRACE")
                    .ok_or("native storage trace path missing")?;
                if !Path::new(&path).is_absolute() {
                    return Err("native storage trace path must be absolute".into());
                }
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|error| error.to_string())?;
                Ok(Sink {
                    file,
                    bytes: 0,
                    sequence: 0,
                    failed: false,
                })
            })())
        });
        let write = || -> Result<(), String> {
            let mut guard = result.lock().map_err(|error| error.to_string())?;
            let sink = guard.as_mut().map_err(|error| error.clone())?;
            if sink.failed {
                return Ok(());
            }
            let mut entry = json!({
                "version": 1, "source": "native_storage_host", "sequence": sink.sequence,
                "context": self.context, "request": self.request,
                "response": {"request_id": response.request_id.to_string(), "result": result_value(&response.result)},
            });
            let mut bytes = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
            if sink.bytes.saturating_add(bytes.len()) > MAXIMUM_BYTES {
                sink.failed = true;
                entry = json!({"version": 1, "failure": "observation_limit"});
                bytes = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
            }
            bytes.push(b'\n');
            sink.file
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            sink.bytes += bytes.len();
            sink.sequence += 1;
            Ok(())
        };
        if let Err(error) = write() {
            eprintln!("native storage observation failed: {error}");
        }
    }
}

fn digest(bytes: &[u8]) -> Value {
    json!({"observation": "bulk_bytes_digest", "byteLength": bytes.len(), "blake3": blake3::hash(bytes).to_hex().as_str()})
}

fn request_value(request: &StorageRequest) -> Value {
    let operation = match &request.operation {
        StorageOperation::Write {
            data,
            atomic_replace,
            precondition,
        } => json!({
            "type": "write", "data": digest(data.as_slice()),
            "atomic_replace": atomic_replace, "precondition": precondition,
        }),
        value => json!(value),
    };
    json!({"request_id": request.request_id.to_string(), "namespace": request.namespace,
        "relative_path": request.relative_path, "operation": operation,
        "idempotency_key": request.idempotency_key,
        "deadline_ns": request.deadline_ns.map(|value| value.to_string())})
}

fn result_value(result: &StorageResult) -> Value {
    match result {
        StorageResult::Read { data, revision } => json!({
            "type": "read", "data": digest(data.as_slice()), "revision": revision,
        }),
        StorageResult::ReadChunk {
            data,
            offset,
            complete,
            change_token,
        } => json!({
            "type": "read_chunk", "data": digest(data.as_slice()), "offset": offset.to_string(),
            "complete": complete, "change_token": change_token,
        }),
        value => json!(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use era_protocol::ProtocolBytes;
    use era_runtime_protocol::{StorageNamespace, StoragePrecondition};

    #[test]
    fn native_storage_evidence_retains_exact_ids_and_digests_real_transfer_bytes() {
        let request = StorageRequest {
            request_id: u64::MAX,
            namespace: StorageNamespace::Save,
            relative_path: "save1000.sav".into(),
            idempotency_key: "save".into(),
            deadline_ns: None,
            operation: StorageOperation::Write {
                data: ProtocolBytes::new(vec![3, 5, 7]),
                atomic_replace: true,
                precondition: StoragePrecondition::Missing,
            },
        };
        let value = request_value(&request);
        assert_eq!(value["request_id"], u64::MAX.to_string());
        assert_eq!(value["operation"]["atomic_replace"], true);
        assert_eq!(value["operation"]["data"], digest(&[3, 5, 7]));
        let read = result_value(&StorageResult::Read {
            data: ProtocolBytes::new(vec![3, 5, 7]),
            revision: Some("saved".into()),
        });
        assert_eq!(read["data"], value["operation"]["data"]);
        assert_eq!(read["revision"], "saved");
        assert_eq!(
            result_value(&StorageResult::Written { revision: None })["type"],
            "written"
        );
    }
}
