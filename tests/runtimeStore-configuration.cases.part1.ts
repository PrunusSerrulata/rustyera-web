import { bridge } from "./runtimeStoreTestSupport";
import { snakeCompatibility } from "./compatibilityTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
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

  it("routes an earlier stale projection rejection before an unregistered preference reply", async () => {
    const configuration = {
      project_revision: 4,
      source_digest: new Uint8Array(32),
      entries: [configurationEntry("UseMouse", "YES")],
      restart_pending: false,
      generated_source: null,
    };
    const delayedPreferenceId = deferred<number>();
    let nextMessageId = 1;
    let preferenceApplications = 0;
    let startupPreferenceId: number | undefined;
    let projectionId: number | undefined;
    let currentPreferenceId: number | undefined;
    bridge.submitRuntime.mockImplementation((message) => {
      const messageId = nextMessageId++;
      if (message.type === "projection_observation") projectionId = messageId;
      if (message.type === "apply_client_preferences") {
        preferenceApplications += 1;
        if (preferenceApplications === 1) startupPreferenceId = messageId;
        else {
          currentPreferenceId = messageId;
          return delayedPreferenceId.promise;
        }
      }
      return Promise.resolve(messageId);
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [], configuration }),
      ],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.enableDebug();
    expect(startupPreferenceId).toBeDefined();
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, startupPreferenceId)],
    });
    await advanceUntil(() =>
      bridge.submitRuntime.mock.calls.some(([message]) => message.type === "start"),
    );

    await store.projectViewport({
      width: 100,
      height: 80,
      lineColumns: 20,
      chromeWidth: 0,
      chromeHeight: 0,
    });
    expect(projectionId).toBeDefined();
    const saving = store.saveClientPreferences("global", {
      settings: { UseMouse: "NO" },
    });
    await flushMicrotasks();
    expect(currentPreferenceId).toBeDefined();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "command_rejected",
          {
            message: "projection observation does not match the canonical presentation",
            context: { identity: snakeCompatibility(), stage: "protocol" },
          },
          projectionId,
        ),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.logs.some((entry) => entry.message.includes("非预期的客户端偏好响应"))).toBe(
      false,
    );
    expect(store.settingsBusy).toBe(true);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, currentPreferenceId)],
    });
    delayedPreferenceId.resolve(currentPreferenceId!);
    await vi.advanceTimersByTimeAsync(32);
    await saving;

    expect(store.settingsBusy).toBe(false);
    expect(store.preferencesOpen).toBe(false);
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("projection observation does not match"),
      ),
    ).toBe(false);
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
});
