//! Native SQL ownership follows the runtime's live/candidate identities, not request order.

use crate::storage::StorageExecution;
use era_protocol::{ProtocolBytes, decode_canonical, encode_canonical};
use era_runtime_protocol::{
    SQL_OPERATION, SQL_OPERATION_VERSIONS, ServiceError, ServiceKind, ServiceRequest,
    ServiceResponse, ServiceResult, SqlDatabaseStateV1, SqlOperationV1, SqlProviderHandleV1,
    SqlRequestV1, SqlResponseV1, SqlResultV1,
};
use era_sql_provider::{CancellationHandle, NativeSqlProvider, ProviderRole};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

const TRANSPORT_BUDGET: Duration = Duration::from_secs(30);

#[derive(Default)]
struct SqlCancellation {
    cancelled: Arc<AtomicBool>,
    owner: Mutex<Option<CancellationHandle>>,
}

impl SqlCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(owner) = self.owner.lock()
            && let Some(owner) = owner.as_ref()
        {
            owner.cancel();
        }
    }

    fn attach(&self, handle: CancellationHandle) -> Result<(), String> {
        let mut owner = self.owner.lock().map_err(|error| error.to_string())?;
        if self.cancelled.load(Ordering::Acquire) {
            handle.cancel();
        }
        *owner = Some(handle);
        Ok(())
    }
}

/// Cancellation never needs the host/session/storage mutex held by a blocked operation.
pub(super) struct NativeSqlSession {
    pub host: Mutex<NativeSqlHost>,
    cancellation: Arc<SqlCancellation>,
}

impl Default for NativeSqlSession {
    fn default() -> Self {
        let host = NativeSqlHost::default();
        Self {
            cancellation: Arc::clone(&host.cancellation),
            host: Mutex::new(host),
        }
    }
}

impl NativeSqlSession {
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
}

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct NativeSqlHost {
    owner: Option<NativeSqlProvider>,
    live: Option<SqlProviderHandleV1>,
    candidate: Option<SqlProviderHandleV1>,
    cancellation: Arc<SqlCancellation>,
}

impl NativeSqlHost {
    pub(super) fn sync(
        &mut self,
        live: SqlProviderHandleV1,
        candidate: Option<SqlProviderHandleV1>,
    ) -> Result<(), String> {
        if self.live == Some(live) && self.candidate == candidate {
            return Ok(());
        }
        if let Some(owner) = self.owner.as_mut() {
            if self.candidate == Some(live) {
                owner
                    .promote_candidate(live)
                    .map_err(|error| error.message)?;
                self.live = Some(live);
                self.candidate = None;
            }
            if self.candidate != candidate
                && let Some(old) = self.candidate.take()
            {
                owner.retire(old).map_err(|error| error.message)?;
            }
            if self.live != Some(live) {
                if let Some(old) = self.live.take() {
                    owner.retire(old).map_err(|error| error.message)?;
                }
                owner
                    .register(live, ProviderRole::Live)
                    .map_err(|error| error.message)?;
            }
            if self.candidate != candidate
                && let Some(next) = candidate
            {
                owner
                    .register(next, ProviderRole::Candidate)
                    .map_err(|error| error.message)?;
            }
        }
        self.live = Some(live);
        self.candidate = candidate;
        Ok(())
    }

    pub(super) fn owns(request: &ServiceRequest) -> bool {
        request.kind == ServiceKind::Sql
    }

    pub(super) fn handle(
        &mut self,
        request: ServiceRequest,
        storage: &mut impl FnMut(
            era_runtime_protocol::StorageRequest,
            &StorageExecution,
        ) -> era_runtime_protocol::StorageResponse,
    ) -> ServiceResponse {
        let execution = StorageExecution::new(
            Instant::now() + TRANSPORT_BUDGET,
            Arc::clone(&self.cancellation.cancelled),
        );
        let result = self.execute(&request, storage, &execution).map_or_else(
            |message| ServiceResult::Error {
                error: ServiceError {
                    // A transport failure cannot prove whether a database's current pointer
                    // moved once any storage publication was entered. Never retry it.
                    code: if execution.publication_attempted() {
                        "native_sql/commit_outcome=unknown"
                    } else {
                        "native_sql/commit_outcome=not_committed"
                    }
                    .into(),
                    message: if execution.publication_attempted() {
                        format!(
                            "{message}; last_storage_publication={}",
                            if execution.publication_completed() {
                                "committed"
                            } else {
                                "unknown"
                            }
                        )
                    } else {
                        message
                    },
                },
            },
            |payload| ServiceResult::Ready {
                payload: ProtocolBytes::new(payload),
            },
        );
        ServiceResponse {
            request_id: request.request_id,
            result,
        }
    }

    fn execute(
        &mut self,
        request: &ServiceRequest,
        storage: &mut impl FnMut(
            era_runtime_protocol::StorageRequest,
            &StorageExecution,
        ) -> era_runtime_protocol::StorageResponse,
        execution: &StorageExecution,
    ) -> Result<Vec<u8>, String> {
        execution.checkpoint().map_err(|error| error.to_string())?;
        if request.operation != SQL_OPERATION
            || request.operation_version < SQL_OPERATION_VERSIONS.minimum
            || request.operation_version > SQL_OPERATION_VERSIONS.maximum
        {
            return Err("unsupported native SQL operation/version".into());
        }
        let decoded: SqlRequestV1 = decode_canonical(request.payload.as_slice())
            .map_err(|error| format!("invalid native SQL request: {error}"))?;
        let active =
            self.live == Some(decoded.provider) || self.candidate == Some(decoded.provider);
        if !active {
            // Lifecycle synchronization already destroyed retired handles. A queued cleanup is
            // still acknowledged, but no retired provider may execute or be resurrected.
            if let SqlOperationV1::Disconnect { connection } = decoded.operation {
                return encode_canonical(&SqlResponseV1 {
                    provider: decoded.provider,
                    database: Some(SqlDatabaseStateV1 {
                        connection,
                        connected: false,
                        transaction_active: false,
                        durable_revision: None,
                    }),
                    reader: None,
                    result: SqlResultV1::Disconnected,
                })
                .map_err(|error| error.to_string());
            }
            return Err("native SQL provider is not owned by the active runtime".into());
        }
        if self.owner.is_none() {
            let mut owner = NativeSqlProvider::new().map_err(|error| error.to_string())?;
            self.cancellation.attach(owner.cancellation_handle())?;
            owner
                .register(
                    self.live.ok_or("missing live SQL provider")?,
                    ProviderRole::Live,
                )
                .map_err(|error| error.message)?;
            if let Some(candidate) = self.candidate {
                owner
                    .register(candidate, ProviderRole::Candidate)
                    .map_err(|error| error.message)?;
            }
            self.owner = Some(owner);
        }
        let cancellation = Arc::clone(&self.cancellation);
        let mut bounded_storage = |request: era_runtime_protocol::StorageRequest| {
            if let Err(error) = execution.checkpoint() {
                cancellation.cancel();
                return expired_storage(request.request_id, &error);
            }
            let response = storage(request, execution);
            if execution.checkpoint().is_err() {
                // A syscall already entered may have completed its publication. Keep its
                // observed result, but cancellation makes the actor reject continuation.
                cancellation.cancel();
            }
            response
        };
        let response = self
            .owner
            .as_mut()
            .ok_or("missing native SQL owner")?
            .handle(
                decoded,
                request.operation_version.minor,
                &mut bounded_storage,
            )?;
        execution.checkpoint().map_err(|error| error.to_string())?;
        encode_canonical(&response).map_err(|error| error.to_string())
    }

    pub(super) fn shutdown(&mut self) -> Result<(), String> {
        if let Some(owner) = self.owner.as_mut() {
            owner.shutdown()?;
        }
        self.owner = None;
        self.live = None;
        self.candidate = None;
        // Every synchronous callback has returned before this mutex is acquired, and shutdown
        // confirmed the actor's exit. No old continuation survives clearing this session flag.
        self.cancellation
            .owner
            .lock()
            .map_err(|error| error.to_string())?
            .take();
        self.cancellation.cancelled.store(false, Ordering::Release);
        Ok(())
    }
}

fn expired_storage(
    request_id: u64,
    error: &std::io::Error,
) -> era_runtime_protocol::StorageResponse {
    era_runtime_protocol::StorageResponse {
        request_id,
        result: era_runtime_protocol::StorageResult::Error {
            error: era_runtime_protocol::FrontendIoError {
                kind: era_runtime_protocol::FrontendIoErrorKind::Other,
                message: error.to_string(),
                platform_code: None,
            },
        },
    }
}
