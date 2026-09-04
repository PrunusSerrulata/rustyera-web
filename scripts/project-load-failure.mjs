/* global window */
import assert from "node:assert/strict";

// Runs in the real page; inspect the received report rather than matching rendered log text.
export function captureProjectLoadFailure() {
  const state = window.__RUSTYERA_TEST__.snapshot();
  const { records, ...summary } = state.serviceEvidence;
  return {
    bridgeKind: state.bridgeKind,
    buildIdentity: state.buildIdentity,
    phase: state.phase,
    status: state.status,
    projectLoading: state.projectLoading,
    startupTelemetry: state.startupTelemetry,
    fault: state.fault,
    logNotifications: state.logNotifications,
    logs: state.logs,
    evidence: {
      ...summary,
      records: records.filter((record) => record.message?.type === "project_load_report"),
    },
  };
}

export function assertProjectLoadFailure(state, diagnosticCode) {
  assert.ok(typeof diagnosticCode === "string" && diagnosticCode.length > 0);
  assert.equal(state.evidence.enabled, true);
  assert.equal(state.evidence.failure, null);
  assert.equal(state.evidence.overflow, false);
  assert.equal(state.fault, null, "a compilation rejection must not become a frontend crash");
  assert.equal(state.projectLoading, false);
  assert.equal(state.startupTelemetry?.outcome, "failure");
  assert.equal(state.status, "项目加载失败，请查看日志");
  const reports = state.evidence.records.filter((record) => record.direction === "receive");
  const report = reports.at(-1)?.message.value;
  assert.equal(report?.success, false);
  assert.ok(!report.payload_required, "a cache miss is not a compilation failure");
  assert.ok(
    report.diagnostics.some(
      (diagnostic) => diagnostic.level === "error" && diagnostic.code === diagnosticCode,
    ),
  );
  assert.ok(
    state.logNotifications.length <= 32,
    "diagnostic burst must be bounded before DOM rendering",
  );
  assert.ok(state.logs.some((entry) => entry.level === "error"));
}
