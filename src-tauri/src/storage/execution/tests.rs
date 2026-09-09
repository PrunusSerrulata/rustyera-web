use super::*;
use crate::storage::{HASH_BUFFER_BYTES, StorageHost, read_bounded_with_revision, stream_revision};
use era_protocol::ProtocolBytes;
use era_runtime_protocol::{
    FrontendIoErrorKind, StorageNamespace, StorageOperation, StoragePrecondition, StorageRequest,
    StorageResult,
};
use std::fs;
use std::sync::Mutex;
use std::time::Duration;

fn guard() -> StorageExecution {
    StorageExecution::new(
        Instant::now() + Duration::from_secs(30),
        Arc::new(AtomicBool::new(false)),
    )
}

fn request(operation: StorageOperation) -> StorageRequest {
    StorageRequest {
        request_id: 42,
        namespace: StorageNamespace::Data,
        relative_path: "state.db".into(),
        operation,
        idempotency_key: String::new(),
        deadline_ns: None,
    }
}

fn write(atomic_replace: bool, precondition: StoragePrecondition) -> StorageOperation {
    StorageOperation::Write {
        data: ProtocolBytes::new(b"new".to_vec()),
        atomic_replace,
        precondition,
    }
}

#[test]
fn expired_read_and_write_have_no_storage_side_effects() {
    let root = tempfile::tempdir().unwrap();
    let mut host = StorageHost::new(root.path().to_owned());
    let execution = StorageExecution::new(Instant::now(), Arc::new(AtomicBool::new(false)));
    assert_eq!(
        execution.checkpoint().unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    for operation in [
        StorageOperation::Read,
        write(true, StoragePrecondition::Any),
        write(false, StoragePrecondition::Any),
    ] {
        assert!(matches!(
            host.handle_sql_with_project(request(operation), None, &execution)
                .result,
            StorageResult::Error { .. }
        ));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    assert!(!execution.publication_attempted());
    assert!(!execution.publication_completed());
}

#[test]
fn cancellation_at_prepublication_preserves_target_and_removes_temporary() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("data")).unwrap();
    let target = root.path().join("data/state.db");
    fs::write(&target, b"old").unwrap();
    let mut host = StorageHost::new(root.path().to_owned());
    let mut execution = guard();
    let cancelled = execution.cancelled.clone();
    let inspected_target = target.clone();
    execution.hook = Some(Arc::new(move |phase| {
        if phase == Phase::BeforePublication {
            assert_eq!(fs::read(&inspected_target).unwrap(), b"old");
            assert_eq!(
                fs::read_dir(inspected_target.parent().unwrap())
                    .unwrap()
                    .count(),
                2
            );
            cancelled.store(true, Ordering::Release);
        }
    }));
    let response = host.handle_sql_with_project(
        request(write(true, StoragePrecondition::Any)),
        None,
        &execution,
    );
    assert!(
        matches!(response.result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Interrupted)
    );
    assert_eq!(fs::read(&target).unwrap(), b"old");
    assert_eq!(fs::read_dir(root.path().join("data")).unwrap().count(), 1);
    assert!(!execution.publication_attempted());
}

#[test]
fn late_cancellation_retains_written_and_deleted_results() {
    for operation in [
        write(true, StoragePrecondition::Any),
        write(false, StoragePrecondition::Any),
        StorageOperation::Delete {
            precondition: StoragePrecondition::Any,
        },
    ] {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        let target = root.path().join("data/state.db");
        fs::write(&target, b"old").unwrap();
        let deleted = matches!(operation, StorageOperation::Delete { .. });
        let mut host = StorageHost::new(root.path().to_owned());
        let mut execution = guard();
        let cancelled = execution.cancelled.clone();
        execution.hook = Some(Arc::new(move |phase| {
            if phase == Phase::AfterPublication {
                cancelled.store(true, Ordering::Release);
            }
        }));
        let observer = execution.clone();
        let response = host.handle_sql_with_project(request(operation), None, &execution);
        if deleted {
            assert!(matches!(response.result, StorageResult::Deleted));
            assert!(!target.exists());
        } else {
            assert!(
                matches!(response.result, StorageResult::Written { revision: Some(value) } if value == crate::storage::path::revision(b"new"))
            );
            assert_eq!(fs::read(&target).unwrap(), b"new");
        }
        assert!(observer.publication_attempted());
        assert!(observer.publication_completed());
        assert_eq!(
            observer.checkpoint().unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
    }
}

#[test]
fn entered_publication_preserves_syscall_success_or_failure() {
    for succeeds in [true, false] {
        let execution = guard();
        let observer = execution.clone();
        let result = publish(Some(&execution), || {
            assert!(observer.publication_attempted());
            assert!(!observer.publication_completed());
            observer.cancelled.store(true, Ordering::Release);
            if succeeds {
                Ok(17)
            } else {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            }
        });
        if succeeds {
            assert_eq!(result.unwrap(), 17);
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        }
        assert_eq!(observer.publication_completed(), succeeds);
    }
}

#[test]
fn chunk_read_and_precondition_hash_stop_at_deadline() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("large.db");
    fs::write(&target, vec![7; HASH_BUFFER_BYTES * 3]).unwrap();
    for hash_only in [false, true] {
        let mut execution = guard();
        let clock = Arc::new(Mutex::new(Instant::now()));
        execution.clock = Some(clock.clone());
        let deadline = execution.deadline;
        let chunks = Arc::new(AtomicU8::new(0));
        let observed = chunks.clone();
        execution.hook = Some(Arc::new(move |phase| {
            if phase == Phase::ReadChunk {
                observed.fetch_add(1, Ordering::Relaxed);
                // Advance the test clock at a precise completed chunk, without
                // scheduler timing, sleeps, or a production clock override.
                *clock.lock().unwrap() = deadline;
            }
        }));
        let error = if hash_only {
            stream_revision(&target, Some(&execution)).unwrap_err()
        } else {
            read_bounded_with_revision(&target, Some(&execution)).unwrap_err()
        };
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(chunks.load(Ordering::Relaxed), 1);
        assert!(!execution.publication_attempted());
    }
}

#[test]
fn resource_writes_remain_read_only_even_when_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let mut host = StorageHost::new(root.path().to_owned());
    let execution = guard();
    execution.cancelled.store(true, Ordering::Release);
    let mut request = request(write(true, StoragePrecondition::Any));
    request.namespace = StorageNamespace::Resource;
    let result = host
        .handle_sql_with_project(request, None, &execution)
        .result;
    assert!(
        matches!(result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::ReadOnly)
    );
    assert!(!execution.publication_attempted());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn preconditions_still_reject_without_entering_publication() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("data")).unwrap();
    let target = root.path().join("data/state.db");
    fs::write(&target, b"old").unwrap();
    let mut host = StorageHost::new(root.path().to_owned());
    for precondition in [
        StoragePrecondition::Missing,
        StoragePrecondition::Revision("wrong".into()),
    ] {
        let execution = guard();
        let result = host
            .handle_sql_with_project(request(write(true, precondition)), None, &execution)
            .result;
        assert!(
            matches!(result, StorageResult::Error { error } if error.kind == FrontendIoErrorKind::Conflict)
        );
        assert!(!execution.publication_attempted());
        assert_eq!(fs::read(&target).unwrap(), b"old");
    }
}
