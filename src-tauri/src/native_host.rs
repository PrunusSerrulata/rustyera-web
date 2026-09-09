//! One mutable host context serializes storage and service access without relocking storage.

use era_runtime_protocol::{
    ServiceRequest, ServiceResponse, SqlProviderHandleV1, StorageRequest, StorageResponse,
};
use era_web_bridge::NativeHostHandler;

use crate::{native_sql::NativeSqlHost, project::ProjectHost, storage::StorageHost};

pub(super) struct NativeHost<'a> {
    pub storage: &'a mut StorageHost,
    pub project: Option<&'a ProjectHost>,
    pub sql: &'a mut NativeSqlHost,
    #[cfg(feature = "performance-audit")]
    pub telemetry: &'a crate::performance_audit::PerformanceAuditTelemetry,
}

impl NativeHostHandler for NativeHost<'_> {
    fn handle_storage(&mut self, request: StorageRequest) -> StorageResponse {
        self.storage.handle_with_project(request, self.project)
    }

    fn handle_service(&mut self, request: ServiceRequest) -> Option<ServiceResponse> {
        if NativeSqlHost::owns(&request) {
            let storage = &mut *self.storage;
            let project = self.project;
            Some(self.sql.handle(request, &mut |request, execution| {
                storage.handle_sql_with_project(request, project, execution)
            }))
        } else {
            crate::services::native_service(request, self.project)
        }
    }

    fn owns_service(&self, request: &ServiceRequest) -> bool {
        NativeSqlHost::owns(request)
    }

    fn sync_sql_providers(
        &mut self,
        live: SqlProviderHandleV1,
        candidate: Option<SqlProviderHandleV1>,
    ) -> Result<(), String> {
        self.sql.sync(live, candidate)
    }

    #[cfg(feature = "performance-audit")]
    fn record_completion(
        &mut self,
        completion: era_web_bridge::NativeCompletionEvidence,
    ) -> Result<(), String> {
        self.telemetry.record_native_completion(completion)
    }
}
