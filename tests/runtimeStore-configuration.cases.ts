import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  blake3,
  configurationEntry,
  decodeServicePayload,
  defaultPreferences,
  emptyBatch,
  encodeServicePayload,
  mockProjectSelection,
  useRuntimeStore,
  runtimeEvent,
  deferred,
  flushMicrotasks,
} from "./runtimeStoreTestSupport";

describe("runtime store configuration", () => {
  installRuntimeStoreTestHarness();

  it("rejects diagnosis export before the runtime is ready", async () => {
    const store = useRuntimeStore();

    await store.exportDiagnosis();

    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    expect(store.canExportDiagnosis).toBe(false);
  });

  it("decodes canvas image dimensions through the negotiated service ABI", async () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(8, 13);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(png.buffer).setUint32(16, 320);
    new DataView(png.buffer).setUint32(20, 180);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "service_request",
          {
            request_id: 7,
            kind: "canvas",
            operation: "decode_canvas_image",
            operation_version: { major: 1, minor: 0 },
            payload: [...encodeServicePayload(new Map([[0, png]]))],
          },
          41,
        ),
        runtimeEvent(
          "service_request",
          {
            request_id: 8,
            kind: "canvas",
            operation: "decode_canvas_image",
            operation_version: { major: 1, minor: 0 },
            payload: [...encodeServicePayload(new Map([[0, Uint8Array.of(1, 2, 3)]]))],
          },
          42,
        ),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    const responses = bridge.submitRuntime.mock.calls
      .map((call) => call as unknown as [message: any, correlationId?: number])
      .filter(([message]) => message.type === "service_response");
    expect(responses).toHaveLength(2);
    const [readyCall, errorCall] = responses;
    if (!readyCall || !errorCall) throw new Error("canvas service responses were not submitted");
    expect(readyCall[1]).toBe(41);
    const ready = readyCall[0].value.result;
    expect(ready.type).toBe("ready");
    expect(decodeServicePayload(ready.payload)).toEqual(
      new Map<number, unknown>([
        [0, 320],
        [1, 180],
      ]),
    );
    expect(errorCall[1]).toBe(42);
    expect(errorCall[0].value.result).toMatchObject({ type: "error" });
  });

  it("handles cancellation while a service decode is pending without blocking later events", async () => {
    const metadata = deferred<{
      width: number;
      height: number;
      format: string;
      animated: boolean;
    }>();
    bridge.readImageMetadata.mockReturnValueOnce(metadata.promise);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "service_request",
          {
            request_id: 9,
            kind: "image",
            operation: "image_metadata",
            operation_version: { major: 1, minor: 0 },
            payload: [...encodeServicePayload(new Map([[0, "pending.png"]]))],
          },
          41,
          1,
        ),
        runtimeEvent("cancel_external_request", { request_id: 9, kind: "service" }, undefined, 1),
        runtimeEvent("state_changed", { phase: "waiting_external", epoch: 1 }, undefined, 1),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    expect(store.phase).toBe("waiting_external");
    expect(bridge.readImageMetadata).toHaveBeenCalledWith("pending.png");
    metadata.resolve({ width: 1, height: 1, format: "png", animated: false });
    await flushMicrotasks();
    expect(
      bridge.submitRuntime.mock.calls.some(([message]) => message.type === "service_response"),
    ).toBe(false);
  });

  it("keeps each service event bound to its epoch when the request ID is reused", async () => {
    const metadata = deferred<{
      width: number;
      height: number;
      format: string;
      animated: boolean;
    }>();
    bridge.readImageMetadata
      .mockReturnValueOnce(metadata.promise)
      .mockResolvedValueOnce({ width: 2, height: 3, format: "png", animated: false });
    const request = (resource: string) => ({
      request_id: 9,
      kind: "image",
      operation: "image_metadata",
      operation_version: { major: 1, minor: 0 },
      payload: [...encodeServicePayload(new Map([[0, resource]]))],
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("service_request", request("old.png"), 41, 1),
        runtimeEvent("service_request", request("new.png"), 42, 2),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    metadata.resolve({ width: 1, height: 1, format: "png", animated: false });
    await flushMicrotasks();
    const responses = bridge.submitRuntime.mock.calls.filter(
      ([message]) => message.type === "service_response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0][1]).toBe(42);
    expect(decodeServicePayload(responses[0][0].value.result.payload)).toEqual(
      new Map<number, unknown>([
        [0, 2],
        [1, 3],
        [2, "png"],
        [3, false],
      ]),
    );
  });

  it("reports background service transport failures without fabricating a successful reply", async () => {
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "service_response") throw new Error("service send failed");
      return 1;
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "service_request",
          {
            request_id: 9,
            kind: "entropy",
            operation: "random_seed",
            operation_version: { major: 1, minor: 0 },
            payload: [...encodeServicePayload(new Map())],
          },
          41,
          1,
        ),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await flushMicrotasks();
    expect(
      store.logs.some(
        (entry) =>
          entry.message.includes("前端服务失败") && entry.message.includes("service send failed"),
      ),
    ).toBe(true);
    expect(
      bridge.submitRuntime.mock.calls.filter(([message]) => message.type === "service_response"),
    ).toHaveLength(1);
  });

  it("uses isolated default preferences in end-to-end test builds", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.loadPreferences.mockResolvedValue({
      ...defaultPreferences(),
      fontSizeOverridePx: 28,
      imageScale: 3,
    });
    const store = useRuntimeStore();

    await store.initialize();

    expect(store.preferences).toEqual(defaultPreferences());
    expect(bridge.loadPreferences).not.toHaveBeenCalled();
  });

  it("waits for the correlated client preference response before starting", async () => {
    const configuration = {
      project_revision: 4,
      source_digest: new Uint8Array(32),
      entries: [configurationEntry("UseMouse", "YES")],
      restart_pending: false,
      generated_source: null,
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
    const store = useRuntimeStore();

    await store.enableDebug();
    await Promise.resolve();
    expect(bridge.submitRuntime.mock.calls.some(([message]) => message.type === "start")).toBe(
      false,
    );

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, 1)],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.submitRuntime.mock.calls.some(([message]) => message.type === "start")).toBe(
      true,
    );
  });

  it("preserves an interleaved game wait until a saved preference is acknowledged", async () => {
    const configuration = {
      project_revision: 5,
      source_digest: new Uint8Array(32),
      entries: [configurationEntry("UseMouse", "YES")],
      restart_pending: false,
      generated_source: null,
    };
    let nextMessageId = 1;
    let stage = 0;
    let releaseSaveAcknowledgement = false;
    const latestWait = {
      kind: "integer_value",
      wait_id: 13,
      submission_token: { epoch: 3, id: 8 },
    };
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [], configuration }),
      ],
    });
    bridge.pump.mockImplementation(async () => {
      const commands = bridge.submitRuntime.mock.calls.map(
        ([message]: unknown[]) => (message as { type?: string }).type,
      );
      const preferenceApplications = commands.filter(
        (type: string | undefined) => type === "apply_client_preferences",
      ).length;
      if (stage === 0 && preferenceApplications === 1) {
        stage = 1;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("client_preferences_applied", { configuration }, 1)],
        };
      }
      if (stage === 1 && commands.includes("start")) {
        stage = 2;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("state_changed", { phase: "running", epoch: 2 })],
        };
      }
      if (stage === 2 && preferenceApplications === 2) {
        stage = 3;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("state_changed", { phase: "waiting_input", epoch: 3 }),
            runtimeEvent("presentation_snapshot", {
              revision: 9,
              title: "preference race",
              history: { logical_lines: [] },
              input_wait: latestWait,
            }),
            runtimeEvent("wait_changed", { type: "opened", value: latestWait }),
            runtimeEvent("client_preferences_applied", { configuration }, 1),
          ],
        };
      }
      if (stage === 3 && releaseSaveAcknowledgement) {
        stage = 4;
        return {
          ...emptyBatch(),
          events: [runtimeEvent("client_preferences_applied", { configuration }, 3)],
        };
      }
      return emptyBatch();
    });
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.enableDebug();
    await advanceUntil(() => stage === 2 && store.phase === "running");
    store.preferencesOpen = true;
    const saving = store.saveClientPreferences("global", {
      settings: { UseMouse: "NO" },
    });
    await advanceUntil(() => stage === 3);

    expect(store.settingsBusy).toBe(true);
    expect(store.preferencesOpen).toBe(true);
    expect(store.phase).toBe("waiting_input");
    expect(store.runtimeEpoch).toBe(3);
    expect(store.presentation.inputWait).toEqual(latestWait);
    expect(store.status).toContain("正在保存客户端偏好");

    releaseSaveAcknowledgement = true;
    await advanceUntil(() => stage === 4);
    await saving;

    expect(store.settingsBusy).toBe(false);
    expect(store.preferencesOpen).toBe(false);
    expect(store.phase).toBe("waiting_input");
    expect(store.runtimeEpoch).toBe(3);
    expect(store.presentation.inputWait).toEqual(latestWait);
    expect(store.status).toBe("全局偏好已应用");
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "start",
      ),
    ).toHaveLength(1);
  });

  it("keeps one pending browser font request while the authorization dialog is open", async () => {
    bridge.kind = "browser";
    let resolveFonts!: (result: { kind: "ready"; fonts: string[] }) => void;
    bridge.listFonts.mockReturnValue(
      new Promise((resolve) => {
        resolveFonts = resolve;
      }),
    );
    const store = useRuntimeStore();

    store.openPreferencesFromUser();
    store.openPreferencesFromUser();
    expect(store.preferencesOpen).toBe(true);
    expect(store.fontAccessStatus).toBe("loading");
    const pending = store.requestSystemFonts();
    expect(bridge.listFonts).toHaveBeenCalledOnce();

    resolveFonts({ kind: "ready", fonts: ["Beta", "Alpha"] });
    await pending;

    expect(bridge.listFonts).toHaveBeenCalledOnce();
    expect(store.systemFonts).toEqual(["Beta", "Alpha"]);
    expect(store.fontAccessStatus).toBe("ready");
  });

  it("submits sparse global and project preference layers before starting the project", async () => {
    bridge.projectPreferencesWritable.mockReturnValue(false);
    bridge.currentProjectPreferences.mockReturnValue({
      settings: { FontSize: "24" },
      masterVolume: 0.4,
      interactionAssistMode: "off",
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 7,
            source_digest: new Uint8Array(32),
            restart_pending: false,
            generated_source: null,
            entries: [configurationEntry("UseMouse", "YES"), configurationEntry("FontSize", "18")],
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    expect(store.projectPreferencesWritable).toBe(false);
    bridge.projectPreferencesWritable.mockReturnValue(true);
    store.preferences.settings.UseMouse = "NO";

    await store.enableDebug();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "apply_client_preferences",
        value: {
          project_revision: 7,
          global: [{ code: "UseMouse", value: "NO" }],
          project: [{ code: "FontSize", value: "24" }],
        },
      },
      undefined,
    );
    expect(store.effectivePreferences.masterVolume).toBe(0.4);
    expect(store.effectivePreferences.interactionAssistMode).toBe("off");
    expect(store.projectPreferencesWritable).toBe(true);
  });

  it("does not present generic runtime fallbacks as installed browser fonts", async () => {
    bridge.kind = "browser";
    bridge.listFonts.mockResolvedValue({ kind: "unsupported" });
    const store = useRuntimeStore();

    await store.requestSystemFonts();

    expect(store.systemFonts).toEqual([]);
    expect(store.fontAccessStatus).toBe("unsupported");
  });

  it("allows retry after a browser font permission denial", async () => {
    bridge.kind = "browser";
    bridge.listFonts.mockResolvedValueOnce({ kind: "denied" });
    const store = useRuntimeStore();

    await store.requestSystemFonts();
    expect(store.fontAccessStatus).toBe("denied");

    bridge.listFonts.mockResolvedValueOnce({ kind: "ready", fonts: ["Project Font"] });
    await store.requestSystemFonts();
    expect(bridge.listFonts).toHaveBeenCalledTimes(2);
    expect(store.fontAccessStatus).toBe("ready");
    expect(store.systemFonts).toEqual(["Project Font"]);
  });

  it("offers loaded project fonts before same-named system fonts", async () => {
    bridge.kind = "browser";
    bridge.listFonts.mockResolvedValue({
      kind: "ready",
      fonts: ["project font", "System Font"],
    });
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
      projectFonts: {
        fonts: ["Project Font"],
        errors: ["font/broken.ttf：invalid font"],
      },
    });
    const store = useRuntimeStore();

    await store.openProject();
    await store.requestSystemFonts();

    expect(store.systemFonts).toEqual(["project font", "System Font"]);
    expect(store.availableFontFamilies).toEqual(["Project Font", "System Font"]);
    expect(store.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          message: "无法加载项目字体：font/broken.ttf：invalid font",
        }),
      ]),
    );
  });

  it("reports the configured game viewport before starting a new game", async () => {
    const viewport = document.createElement("main");
    viewport.className = "game-viewport";
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1100 },
      clientHeight: { configurable: true, value: 750 },
    });
    document.body.append(viewport);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: null,
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    const commands = bridge.submitRuntime.mock.calls.map((call: unknown[]) => call[0] as any);
    const projectionIndex = commands.findIndex(
      (command) => command.type === "projection_observation",
    );
    const startIndex = commands.findIndex((command) => command.type === "start");
    expect(projectionIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(projectionIndex);
    expect(commands[projectionIndex]).toMatchObject({
      value: { client_size: { width: 1100, height: 750 } },
    });
  });

  it("projects only defined game information from a successful project report", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: null,
          game_information: {
            title: "Demo",
            author: "   ",
            version: "1.001",
            year: null,
            information: "Notes",
          },
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    expect(store.gameInformation).toEqual({
      title: "Demo",
      author: undefined,
      version: "1.001",
      year: undefined,
      information: "Notes",
    });
  });

  it("continues startup when the host suspends animation frames", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: null,
        }),
      ],
    });
    const store = useRuntimeStore();

    const startup = store.enableDebug();
    await vi.advanceTimersByTimeAsync(100);
    await startup;

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "start", value: { mode: { type: "new_game", seed: null } } },
      undefined,
    );
  });

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
    expect(store.logNotifications).toHaveLength(10_000);
    expect(store.logs[0].message).toContain("error 5");
    expect(store.logNotifications[0]?.message).toContain("error 5");
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
            22,
          ),
        ],
      });
    await vi.advanceTimersByTimeAsync(64);
    expect(store.configurationReadOnly).toBe(false);

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
