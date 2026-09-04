import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  blake3,
  configurationEntry,
  emptyBatch,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store configuration", () => {
  installRuntimeStoreTestHarness();

  it("retains the newest project diagnostics without incrementally trimming the log", async () => {
    const diagnostics = Array.from({ length: 10_050 }, (_, index) => ({
      code: "runtime.duplicate_sprite",
      level: "warning",
      notification: index < 50 ? "default" : "log_only",
      message: `duplicate ${index}`,
    }));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: false,
          payload_required: false,
          diagnostics,
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs).toHaveLength(10_000);
    expect(store.logs[0].message).toContain("duplicate 50");
    expect(store.logs.at(-1)?.message).toContain("duplicate 10049");
    expect(store.logNotifications).toEqual([]);
  });

  it("surfaces ordered non-fatal warnings and errors without duplicating fatal errors", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("diagnostic", {
          code: "runtime.compatibility",
          level: "warning",
          notification: "default",
          message: "legacy behavior",
          source: { relative_path: "ERB/WARN.ERB", line: 4, byte_column: 2 },
        }),
        runtimeEvent("diagnostic", {
          code: "runtime.resource",
          level: "error",
          message: "recoverable error",
          source: { relative_path: "ERB/ERROR.ERB", line: 6, byte_column: 1 },
        }),
        runtimeEvent("command_rejected", {
          code: "invalid_state",
          message: "command failed",
          source: { relative_path: "ERB/COMMAND.ERB", line: 8, byte_column: 0 },
        }),
        runtimeEvent("log", {
          level: "error",
          message: "recoverable context also mentions division by zero",
        }),
        runtimeEvent("log", {
          level: "error",
          message: "runtime fault [VmFault]: division by zero",
        }),
        runtimeEvent("fault", {
          code: "vm_fault",
          message: "division by zero",
          origin: {
            function: "CALCULATE",
            source: { relative_path: "ERB/FAULT.ERB", line: 12, byte_column: 5 },
          },
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs.map((entry) => entry.message)).toEqual([
      "ERB/WARN.ERB:5:3: [runtime.compatibility] legacy behavior",
      "ERB/ERROR.ERB:7:2: [runtime.resource] recoverable error",
      "ERB/COMMAND.ERB:9:1: [invalid_state] command failed",
      "recoverable context also mentions division by zero",
      "runtime fault [VmFault]: division by zero",
      "Runtime 故障 [VmFault] [CALCULATE]：division by zero（ERB/FAULT.ERB:12:6）",
    ]);
    expect(store.logNotifications).toEqual([
      {
        id: 1,
        level: "warning",
        message: "ERB/WARN.ERB:5:3: [runtime.compatibility] legacy behavior",
      },
      {
        id: 2,
        level: "error",
        message: "ERB/ERROR.ERB:7:2: [runtime.resource] recoverable error",
      },
      {
        id: 3,
        level: "warning",
        message: "ERB/COMMAND.ERB:9:1: [invalid_state] command failed",
      },
      {
        id: 4,
        level: "error",
        message: "recoverable context also mentions division by zero",
      },
    ]);
    store.dismissLogNotification(2);
    expect(store.logNotifications.map((notification) => notification.id)).toEqual([1, 3, 4]);
    expect(store.logs).toHaveLength(6);
  });

  it.each([
    {
      label: "suppresses the exact mirrored Runtime log",
      logCode: "InvalidState",
      expectedNotifications: 1,
    },
    {
      label: "keeps a near-match with a different rejection code",
      logCode: "StaleRequest",
      expectedNotifications: 2,
    },
  ])("$label", async ({ logCode, expectedNotifications }) => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("command_rejected", {
          code: "invalid_state",
          message: "operation is unavailable",
        }),
        runtimeEvent("log", {
          level: "warning",
          message: `command rejected [${logCode}]: operation is unavailable`,
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs.map((entry) => entry.message)).toEqual([
      "[invalid_state] operation is unavailable",
      `command rejected [${logCode}]: operation is unavailable`,
    ]);
    expect(store.logNotifications).toHaveLength(expectedNotifications);
    expect(store.logNotifications[0]).toEqual({
      id: 1,
      level: "warning",
      message: "[invalid_state] operation is unavailable",
    });
  });

  it("honors compile diagnostic notification guidance while surfacing errors", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: false,
          payload_required: false,
          diagnostics: [
            {
              code: "compile.warning",
              level: "warning",
              notification: "log_only",
              message: "compile warning",
            },
            {
              code: "compile.default_warning",
              level: "warning",
              notification: "default",
              message: "default compile warning",
            },
            {
              code: "compile.error",
              level: "error",
              notification: "default",
              message: "compile error",
            },
          ],
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs.map((entry) => entry.message)).toEqual([
      "[compile.warning] compile warning",
      "[compile.default_warning] default compile warning",
      "[compile.error] compile error",
    ]);
    expect(store.logNotifications).toEqual([
      { id: 1, level: "error", message: "[compile.error] compile error" },
    ]);
  });

  it("retains crossed HTML closing-tag diagnostics without showing a notification", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("diagnostic", {
          code: "runtime.html.nonstandard_crossed_closing_tag",
          level: "warning",
          notification: "log_only",
          message: "PRINTHTML normalized non-standard crossed closing tag",
          source: { relative_path: "ERB/HTML.ERB", line: 4, byte_column: 2 },
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs).toEqual([
      expect.objectContaining({
        level: "warning",
        message:
          "ERB/HTML.ERB:5:3: [runtime.html.nonstandard_crossed_closing_tag] PRINTHTML normalized non-standard crossed closing tag",
      }),
    ]);
    expect(store.logNotifications).toEqual([]);
  });

  it("retains GOTO-into-CASE warnings without showing a notification", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("diagnostic", {
          code: "vm.control_flow.goto_into_structured_block",
          level: "warning",
          notification: "log_only",
          message:
            "GOTO entered a structured block without executing its opener; avoid jumping into FOR, REPEAT, or SELECTCASE blocks",
          source: { relative_path: "ERB/GUILD/GUILD.ERB", line: 341, byte_column: 5 },
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs).toEqual([
      expect.objectContaining({
        level: "warning",
        message:
          "ERB/GUILD/GUILD.ERB:342:6: [vm.control_flow.goto_into_structured_block] GOTO entered a structured block without executing its opener; avoid jumping into FOR, REPEAT, or SELECTCASE blocks",
      }),
    ]);
    expect(store.logNotifications).toEqual([]);
  });

  it("does not notify for a standalone fatal fault", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("fault", { code: "vm_fault", message: "fatal" })],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.fault).toMatchObject({ code: "vm_fault", message: "fatal" });
    expect(store.logs.at(-1)?.message).toContain("Runtime 故障 [VmFault]");
    expect(store.logNotifications).toEqual([]);
  });

  it("bounds pending notifications without deleting retained logs", async () => {
    const diagnostics = Array.from({ length: 10_005 }, (_, index) => ({
      code: "compile.error",
      level: "error",
      message: `error ${index}`,
    }));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: false,
          payload_required: false,
          diagnostics,
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.logs).toHaveLength(10_000);
    expect(store.logNotifications).toHaveLength(32);
    expect(store.logs[0].message).toContain("error 5");
    expect(store.logNotifications[0]?.message).toContain("error 9973");
    expect(store.status).toBe("项目加载失败，请查看日志");
    expect(store.projectLoading).toBe(false);
    expect(store.canOpenProject).toBe(true);
  });

  it("does not notify when a pump failure opens the fatal dialog", async () => {
    bridge.pump.mockRejectedValueOnce(new Error("pump failed"));
    const store = useRuntimeStore();

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.fault).toMatchObject({ code: "frontend", message: "Error: pump failed" });
    expect(store.logs.at(-1)?.message).toBe("Error: pump failed");
    expect(store.logNotifications).toEqual([]);
  });

  it("does not notify when fault recovery opens another fatal dialog", async () => {
    bridge.submitRuntime.mockRejectedValueOnce(new Error("recovery failed"));
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.phase = "faulted";
    store.fault = { code: "vm_fault", message: "original fault" };

    await store.recoverFromFault("title");

    expect(store.fault).toMatchObject({
      code: "frontend.recovery_failed",
      message: "错误恢复失败：Error: recovery failed",
    });
    expect(store.logs.at(-1)?.message).toBe("错误恢复失败：Error: recovery failed");
    expect(store.logNotifications).toEqual([]);
  });

  it("clears the returning-to-title status after fault recovery is accepted", async () => {
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.phase = "faulted";
    store.fault = { code: "vm_fault", message: "original fault" };

    await store.recoverFromFault("title");

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ type: "return_to_title", value: {} }),
      undefined,
    );
    expect(store.status).toBe("游戏运行中");
  });

  it("exposes applicable reraconfig entries and asks Runtime to validate changes", async () => {
    const configuration = {
      project_revision: 9,
      source_digest: new Uint8Array(32).fill(4),
      entries: [
        {
          code: "FontSize",
          japanese: "フォントサイズ",
          english: "Font size",
          value: "12",
          effective_value: "12",
          preference_eligible: true,
          client_effective_value: "12",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
        {
          code: "TuiOnly",
          japanese: "",
          english: "TUI only",
          value: "TRUE",
          effective_value: "TRUE",
          preference_eligible: false,
          client_effective_value: "TRUE",
          kind: "boolean",
          allowed: [],
          fixed: false,
          applicability: 2,
        },
        {
          code: "UseMenu",
          japanese: "メニュー表示",
          english: "Menu visibility",
          value: "HIDE",
          effective_value: "HIDE",
          preference_eligible: true,
          client_effective_value: "HIDE",
          kind: "enum",
          allowed: ["SHOW", "AUTO", "HIDE"],
          fixed: false,
          applicability: 12,
        },
        {
          code: "UseMouse",
          japanese: "マウスを使用する",
          english: "Use mouse",
          value: "NO",
          effective_value: "NO",
          preference_eligible: true,
          client_effective_value: "NO",
          kind: "boolean",
          allowed: [],
          fixed: false,
          applicability: 12,
        },
        {
          code: "ScrollHeight",
          japanese: "スクロール行数",
          english: "Lines per scroll",
          value: "4",
          effective_value: "4",
          preference_eligible: true,
          client_effective_value: "4",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 12,
        },
      ],
    };
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration,
        }),
      ],
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, 1)],
    });
    const store = useRuntimeStore();

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(16);
    expect(store.configurationEntries.map((entry) => entry.code)).toEqual([
      "FontSize",
      "UseMenu",
      "UseMouse",
      "ScrollHeight",
    ]);
    expect(store.menuMode).toBe("HIDE");
    expect(store.useMouse).toBe(false);
    expect(store.scrollHeight).toBe(4);
    expect(bridge.applyProjectConfiguration).toHaveBeenCalledWith(
      [
        expect.objectContaining({ code: "FontSize" }),
        expect.objectContaining({ code: "UseMenu" }),
        expect.objectContaining({ code: "UseMouse" }),
        expect.objectContaining({ code: "ScrollHeight" }),
      ],
      { width: 0, height: 0 },
    );

    void store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.status).toMatch(/ · 已等待 1 秒$/);

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "prepare_configuration_update",
        value: {
          project_revision: 9,
          expected_source_digest: new Array(32).fill(4),
          changes: [{ code: "FontSize", value: "18" }],
        },
      },
      undefined,
    );
  });

  it("persists a generated reraconfig with the absent-file precondition", async () => {
    const generated = "[meta]\nschema_version = 2\n";
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 1,
            source_digest: new Uint8Array(),
            entries: [],
            restart_pending: false,
            generated_source: generated,
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await Promise.resolve();

    expect(bridge.writeProjectConfiguration).toHaveBeenCalledWith(new Uint8Array(), generated);
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "prepare_configuration_update",
        value: { project_revision: 1, expected_source_digest: [], changes: [] },
      },
      undefined,
    );
    expect(store.configurationReadOnly).toBe(true);
  });

  it("confirms an upgraded reraconfig before accepting another edit", async () => {
    const original = "[meta]\nschema_version = 1\n[text]\nfont_size = 20\n";
    const generated = "[meta]\nschema_version = 2\n[text]\nfont_size = 20\n";
    const digest = blake3(new TextEncoder().encode(original));
    const generatedDigest = blake3(new TextEncoder().encode(generated));
    const updated = "[meta]\nschema_version = 2\n[text]\nfont_size = 22\n";
    const updatedDigest = blake3(new TextEncoder().encode(updated));
    let messageId = 20;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 1,
            source_digest: digest,
            entries: [configurationEntry("FontSize", "20")],
            restart_pending: false,
            generated_source: generated,
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await Promise.resolve();
    expect(
      bridge.submitRuntime.mock.calls.some(([message]) =>
        ["apply_client_preferences", "start"].includes(message.type),
      ),
    ).toBe(false);
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 1,
              expected_source_digest: digest,
              contents: generated,
              restart_required: false,
              prepared_source_digest: generatedDigest,
            },
            20,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            {
              configuration: {
                project_revision: 1,
                source_digest: generatedDigest,
                entries: [configurationEntry("FontSize", "20")],
                restart_pending: false,
                generated_source: null,
              },
            },
            21,
          ),
        ],
      });
    await vi.advanceTimersByTimeAsync(64);
    expect(store.configurationReadOnly).toBe(false);
    const startupCommands = bridge.submitRuntime.mock.calls.map(([message]) => message.type);
    expect(startupCommands.indexOf("apply_client_preferences")).toBeGreaterThan(
      startupCommands.indexOf("finalize_configuration_update"),
    );

    const saving = store.saveProjectSettings([{ code: "FontSize", value: "22" }]);
    await Promise.resolve();
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 1,
              expected_source_digest: generatedDigest,
              contents: updated,
              restart_required: false,
              prepared_source_digest: updatedDigest,
            },
            23,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            {
              configuration: {
                project_revision: 1,
                source_digest: updatedDigest,
                entries: [configurationEntry("FontSize", "22")],
                restart_pending: false,
                generated_source: null,
              },
            },
            24,
          ),
        ],
      });
    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.writeProjectConfiguration).toHaveBeenCalledWith(digest, generated);
    expect(bridge.writeProjectConfiguration).toHaveBeenCalledWith(generatedDigest, updated);
  });
});
