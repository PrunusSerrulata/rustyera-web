use super::*;
use era_runtime_protocol::{FrontendIoErrorKind, StoragePrecondition};

fn resource_request(path: &str, operation: StorageOperation) -> StorageRequest {
    StorageRequest {
        request_id: 1,
        namespace: StorageNamespace::Resource,
        relative_path: path.into(),
        operation,
        idempotency_key: String::new(),
        deadline_ns: None,
    }
}

fn data_request(path: &str, operation: StorageOperation) -> StorageRequest {
    StorageRequest {
        namespace: StorageNamespace::Data,
        ..resource_request(path, operation)
    }
}

mod limits;
mod profiles;
