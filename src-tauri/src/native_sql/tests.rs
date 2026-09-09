use super::*;
use era_runtime_protocol::{
    SQL_DATABASE_FORMAT_VERSION, SQL_READER_ROW_VERSION, SQL_SQLITE_VERSION, SqlConnectionHandleV1,
    SqlDatabaseIdentityV1, SqlDatabaseSourceV1, SqlExecuteModeV1, SqlLimitsV1, SqlOpenRevisionV1,
    SqlValueV1,
};

fn provider(epoch: u64) -> SqlProviderHandleV1 {
    SqlProviderHandleV1 {
        service_epoch: epoch,
        id: 1,
    }
}

fn connection(epoch: u64) -> SqlConnectionHandleV1 {
    SqlConnectionHandleV1 {
        service_epoch: epoch,
        id: 1,
    }
}

fn request(epoch: u64, operation: SqlOperationV1) -> ServiceRequest {
    ServiceRequest {
        request_id: 42,
        kind: ServiceKind::Sql,
        operation: SQL_OPERATION.into(),
        operation_version: SQL_READER_ROW_VERSION,
        payload: ProtocolBytes::new(
            encode_canonical(&SqlRequestV1 {
                provider: provider(epoch),
                operation,
            })
            .unwrap(),
        ),
        deadline_ns: None,
    }
}

fn open(epoch: u64, name: &str) -> ServiceRequest {
    request(
        epoch,
        SqlOperationV1::Open {
            connection: connection(epoch),
            logical_name: name.into(),
            identity: SqlDatabaseIdentityV1 {
                source: SqlDatabaseSourceV1::Memory,
                sqlite_version: SQL_SQLITE_VERSION.into(),
                format_version: SQL_DATABASE_FORMAT_VERSION,
            },
            revision: SqlOpenRevisionV1::Current,
            limits: SqlLimitsV1::FIXED,
        },
    )
}

fn call(
    host: &mut NativeSqlHost,
    storage: &mut crate::storage::StorageHost,
    request: ServiceRequest,
) -> SqlResponseV1 {
    let response = host.handle(request, &mut |request, execution| {
        storage.handle_sql_with_project(request, None, execution)
    });
    assert_eq!(response.request_id, 42);
    let ServiceResult::Ready { payload } = response.result else {
        panic!("{response:?}")
    };
    decode_canonical(payload.as_slice()).unwrap()
}

#[test]
fn live_candidate_retirement_and_promotion_follow_runtime_identity() {
    let directory = tempfile::tempdir().unwrap();
    let mut storage = crate::storage::StorageHost::new(directory.path().into());
    let mut host = NativeSqlHost::default();
    host.sync(provider(1), None).unwrap();
    assert!(host.owner.is_none());
    assert!(matches!(
        call(&mut host, &mut storage, open(1, "live")).result,
        SqlResultV1::Opened { .. }
    ));
    host.sync(provider(1), Some(provider(2))).unwrap();
    assert!(matches!(
        call(&mut host, &mut storage, open(2, "failed")).result,
        SqlResultV1::Opened { .. }
    ));
    host.sync(provider(1), None).unwrap();
    let cleanup = request(
        2,
        SqlOperationV1::Disconnect {
            connection: connection(2),
        },
    );
    assert!(matches!(
        call(&mut host, &mut storage, cleanup).result,
        SqlResultV1::Disconnected
    ));
    let scalar = request(
        1,
        SqlOperationV1::Execute {
            connection: connection(1),
            sql: "SELECT 17".into(),
            mode: SqlExecuteModeV1::ScalarInteger,
            parameters: vec![],
        },
    );
    assert!(matches!(
        call(&mut host, &mut storage, scalar).result,
        SqlResultV1::ReusableScalar {
            value: SqlValueV1::Integer(17)
        }
    ));
    host.sync(provider(1), Some(provider(3))).unwrap();
    assert!(matches!(
        call(&mut host, &mut storage, open(3, "next")).result,
        SqlResultV1::Opened { .. }
    ));
    host.sync(provider(3), None).unwrap();
    assert_eq!(host.live, Some(provider(3)));
    assert!(host.candidate.is_none());
    let response = host.handle(open(1, "stale"), &mut |request, execution| {
        storage.handle_sql_with_project(request, None, execution)
    });
    assert!(matches!(response.result, ServiceResult::Error { .. }));
    host.shutdown().unwrap();
    assert!(host.owner.is_none());
}

#[test]
fn claimed_sql_never_falls_back_for_bad_version_payload_or_unknown_operation() {
    let mut host = NativeSqlHost::default();
    host.sync(provider(1), None).unwrap();
    for kind in 0..3 {
        let mut wire = open(1, "bad");
        match kind {
            0 => wire.operation_version = era_protocol::ProtocolVersion::new(9, 0),
            1 => wire.payload = ProtocolBytes::new(vec![0xff]),
            _ => wire.operation = "unknown_sql".into(),
        }
        assert!(NativeSqlHost::owns(&wire));
        let response = host.handle(wire, &mut |_, _| {
            panic!("invalid request cannot use storage")
        });
        assert!(matches!(response.result, ServiceResult::Error { .. }));
    }
    assert!(host.owner.is_none());
}

#[test]
fn cancellation_reaches_a_blocked_storage_callback_without_the_host_lock() {
    use std::sync::mpsc;
    let session = Arc::new(NativeSqlSession::default());
    session
        .host
        .lock()
        .unwrap()
        .sync(provider(1), None)
        .unwrap();
    let worker_session = Arc::clone(&session);
    let (entered, observed) = mpsc::sync_channel(1);
    let (release, resume) = mpsc::sync_channel(1);
    let (result, response) = mpsc::sync_channel(1);
    let worker =
        std::thread::spawn(move || {
            let response = worker_session.host.lock().unwrap().handle(
                open(1, "blocked"),
                &mut |request, _| {
                    entered.send(()).unwrap();
                    resume.recv_timeout(Duration::from_secs(2)).unwrap();
                    era_runtime_protocol::StorageResponse {
                        request_id: request.request_id,
                        result: era_runtime_protocol::StorageResult::Error {
                            error: era_runtime_protocol::FrontendIoError {
                                kind: era_runtime_protocol::FrontendIoErrorKind::NotFound,
                                message: "controlled read returned after cancellation".into(),
                                platform_code: None,
                            },
                        },
                    }
                },
            );
            result.send(response).unwrap();
        });
    observed.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(session.host.try_lock().is_err());
    session.cancel();
    release.send(()).unwrap();
    let returned = response.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
    assert!(
        matches!(returned.result, ServiceResult::Error { error } if error.code.ends_with("not_committed"))
    );
    let mut host = session.host.lock().unwrap();
    host.shutdown().unwrap();
    assert!(host.owner.is_none());
}

#[test]
fn cancellation_after_storage_publication_is_unknown_and_never_retried() {
    let directory = tempfile::tempdir().unwrap();
    let mut storage = crate::storage::StorageHost::new(directory.path().into());
    let mut host = NativeSqlHost::default();
    host.sync(provider(1), None).unwrap();
    let cancellation = Arc::clone(&host.cancellation);
    let mut writes = 0;
    let response = host.handle(open(1, "publication"), &mut |request, execution| {
        let write = matches!(
            request.operation,
            era_runtime_protocol::StorageOperation::Write { .. }
        );
        let response = storage.handle_sql_with_project(request, None, execution);
        if write {
            writes += 1;
            assert!(execution.publication_completed());
            cancellation.cancel();
        }
        response
    });
    assert_eq!(writes, 1);
    assert!(
        matches!(response.result, ServiceResult::Error { error } if error.code.ends_with("unknown"))
    );
    let response = host.handle(open(1, "publication"), &mut |_, _| {
        panic!("cancelled owner must not retry storage")
    });
    assert!(matches!(response.result, ServiceResult::Error { .. }));
    host.shutdown().unwrap();
}
