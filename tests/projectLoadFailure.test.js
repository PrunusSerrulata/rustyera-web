import { describe, expect, it } from "vitest";
import { assertProjectLoadFailure } from "../scripts/project-load-failure.mjs";

function state() {
  return {
    evidence: {
      enabled: true,
      overflow: false,
      failure: null,
      records: [
        {
          direction: "receive",
          message: {
            type: "project_load_report",
            value: {
              success: false,
              payload_required: false,
              diagnostics: [{ level: "error", code: "compiler.invalidhir" }],
            },
          },
        },
      ],
    },
    fault: null,
    projectLoading: false,
    startupTelemetry: { outcome: "failure" },
    status: "项目加载失败，请查看日志",
    logNotifications: [],
    logs: [{ level: "error" }],
  };
}

describe("project load failure evidence", () => {
  it("accepts an explicit rejected compile report", () => {
    expect(() => assertProjectLoadFailure(state(), "compiler.invalidhir")).not.toThrow();
  });
  it("rejects missing diagnostics, cache misses, frontend crashes and stuck loading", () => {
    for (const change of [
      (s) => {
        s.evidence.records[0].message.value.diagnostics = [];
      },
      (s) => {
        s.evidence.records[0].message.value.payload_required = true;
      },
      (s) => {
        s.fault = { code: "frontend" };
      },
      (s) => {
        s.projectLoading = true;
      },
      (s) => {
        s.evidence.overflow = true;
      },
      (s) => {
        s.logNotifications = Array(33).fill({});
      },
    ]) {
      const invalid = state();
      change(invalid);
      expect(() => assertProjectLoadFailure(invalid, "compiler.invalidhir")).toThrow();
    }
  });
});
