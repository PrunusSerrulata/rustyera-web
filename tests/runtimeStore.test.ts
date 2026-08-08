import { blake3 } from "@noble/hashes/blake3.js";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { plainLine } from "@/core/presentation";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import {
  defaultPreferences,
  type Preferences,
  type ProjectProgress,
  type SystemFontQueryResult,
} from "@/core/types";

const emptyBatch = () => ({
  state: "idle" as const,
  vmInstructions: 0,
  runtimeTransitions: 0,
  events: [],
});

function stubRunningAudioContext(): void {
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = vi.fn(async () => {});
      createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
    },
  );
}
const bridge = vi.hoisted(() => ({
  kind: "tauri" as "tauri" | "browser",
  createSession: vi.fn(),
  submitRuntime: vi.fn(async () => 1),
  submitDebug: vi.fn(async () => 1),
  pump: vi.fn(),
  projectProgressListener: undefined as ((progress: ProjectProgress) => void) | undefined,
  setProjectProgressListener: vi.fn(
    (listener: ((progress: ProjectProgress) => void) | undefined) => {
      bridge.projectProgressListener = listener;
    },
  ),
  openProject: vi.fn(),
  openProjectFile: vi.fn(),
  restartProject: vi.fn(),
  submitProjectSource: vi.fn(),
  reloadProject: vi.fn(),
  readResource: vi.fn(),
  readImageMetadata: vi.fn(),
  handleStorage: vi.fn(),
  listFonts: vi.fn(async (): Promise<SystemFontQueryResult> => ({ kind: "ready", fonts: [] })),
  loadPreferences: vi.fn(async () => defaultPreferences()),
  savePreferences: vi.fn(),
  projectConfigurationWritable: vi.fn(() => true),
  writeProjectConfiguration: vi.fn(),
  applyProjectConfiguration: vi.fn(),
  projectName: vi.fn(() => "eraTW"),
  openUpload: vi.fn(),
  saveDownload: vi.fn(),
  beginProjectFileExport: vi.fn(),
  writeProjectFileChunk: vi.fn(),
  cancelProjectFileExport: vi.fn(),
  traditionalSaves: {
    listSlots: vi.fn(),
    exportSlot: vi.fn(),
    pickImport: vi.fn(),
    inspect: vi.fn(),
    writeSlot: vi.fn(),
  },
  saveDiagnosis: vi.fn(),
  writeCompiledCacheChunk: vi.fn(),
  cancelCompiledCacheExport: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/platform", () => ({ platformBridge: () => bridge }));

import { useRuntimeStore } from "@/stores/runtime";

describe("runtime store session lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.clearAllMocks();
    bridge.openProject.mockReset();
    bridge.openProjectFile.mockReset();
    bridge.pump.mockReset();
    bridge.submitRuntime.mockReset();
    bridge.kind = "tauri";
    bridge.createSession.mockResolvedValue(emptyBatch());
    bridge.submitRuntime.mockResolvedValue(1);
    let nextDebugMessageId = 1;
    bridge.submitDebug.mockImplementation(async () => nextDebugMessageId++);
    bridge.pump.mockResolvedValue(emptyBatch());
    bridge.saveDownload.mockResolvedValue(true);
    bridge.beginProjectFileExport.mockResolvedValue(true);
    bridge.traditionalSaves.listSlots.mockResolvedValue([
      { slot: 0, occupied: false },
      { slot: 1, occupied: true },
    ]);
    bridge.traditionalSaves.exportSlot.mockResolvedValue(undefined);
    bridge.traditionalSaves.pickImport.mockResolvedValue(undefined);
    bridge.traditionalSaves.inspect.mockResolvedValue({ description: "valid" });
    bridge.traditionalSaves.writeSlot.mockResolvedValue(undefined);
    bridge.saveDiagnosis.mockResolvedValue(true);
    bridge.writeCompiledCacheChunk.mockResolvedValue(undefined);
    bridge.cancelCompiledCacheExport.mockResolvedValue(undefined);
    bridge.listFonts.mockResolvedValue({ kind: "ready", fonts: [] });
    bridge.savePreferences.mockImplementation(async (value: Preferences) => value);
    bridge.projectConfigurationWritable.mockReturnValue(true);
    bridge.writeProjectConfiguration.mockResolvedValue(undefined);
    bridge.applyProjectConfiguration.mockResolvedValue(undefined);
    bridge.restartProject.mockResolvedValue({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

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
  });

  it("exposes applicable emuera.config entries and asks Runtime to validate changes", async () => {
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 9,
            source_digest: new Uint8Array(32).fill(4),
            entries: [
              {
                code: "FontSize",
                japanese: "フォントサイズ",
                english: "Font size",
                value: "12",
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
                kind: "boolean",
                allowed: [],
                fixed: false,
                applicability: 2,
              },
              {
                code: "UseMenu",
                japanese: "メニューを使用する",
                english: "Show menu",
                value: "NO",
                kind: "boolean",
                allowed: [],
                fixed: false,
                applicability: 12,
              },
              {
                code: "UseMouse",
                japanese: "マウスを使用する",
                english: "Use mouse",
                value: "NO",
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
                kind: "integer",
                allowed: [],
                fixed: false,
                applicability: 12,
              },
            ],
          },
        }),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();
    expect(store.configurationEntries.map((entry) => entry.code)).toEqual([
      "FontSize",
      "UseMenu",
      "UseMouse",
      "ScrollHeight",
    ]);
    expect(store.useMenu).toBe(false);
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

    void store.savePreferences(defaultPreferences(), [{ code: "FontSize", value: "18" }]);
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

  it("continues loading when the host cannot apply a native window setting", async () => {
    bridge.applyProjectConfiguration.mockRejectedValueOnce(new Error("window unavailable"));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 1,
            source_digest: new Uint8Array(32).fill(1),
            entries: [
              {
                code: "SizableWindow",
                japanese: "",
                english: "Resizable window",
                value: "YES",
                kind: "boolean",
                allowed: [],
                fixed: false,
                applicability: 8,
              },
            ],
          },
        }),
      ],
    });
    const store = useRuntimeStore();

    await expect(store.enableDebug()).resolves.toBeUndefined();

    expect(store.fault).toBeNull();
    expect(store.status).toBe("项目编译完成");
    expect(store.logs.at(-1)?.message).toContain("客户端项目配置应用失败");
  });

  it("keeps project progress active until host configuration application finishes", async () => {
    let finishHostConfiguration!: () => void;
    bridge.applyProjectConfiguration.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHostConfiguration = resolve;
      }),
    );
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(2, 3, "18"))],
    });
    const store = useRuntimeStore();
    store.projectLoading = true;

    const loading = store.enableDebug();
    await Promise.resolve();
    expect(store.projectLoading).toBe(true);
    finishHostConfiguration();
    await loading;

    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("项目编译完成");
  });

  it("writes and finalizes a Runtime-prepared configuration without forcing a restart", async () => {
    let messageId = 20;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 3,
            source_digest: new Uint8Array(32).fill(7),
            entries: [
              {
                code: "FontSize",
                japanese: "フォントサイズ",
                english: "Font size",
                value: "12",
                kind: "integer",
                allowed: [],
                fixed: false,
                applicability: 8,
              },
            ],
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    store.projectOpen = true;
    const saving = store.savePreferences(defaultPreferences(), [{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 3,
              expected_source_digest: new Uint8Array(32).fill(7),
              contents: "フォントサイズ:18\n",
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode("フォントサイズ:18\n")),
            },
            21,
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
                project_revision: 3,
                source_digest: blake3(new TextEncoder().encode("フォントサイズ:18\n")),
                restart_pending: false,
                entries: [
                  {
                    code: "FontSize",
                    japanese: "フォントサイズ",
                    english: "Font size",
                    value: "18",
                    effective_value: "18",
                    default_value: "18",
                    application: "hot",
                    kind: "integer",
                    allowed: [],
                    fixed: false,
                    applicability: 8,
                  },
                ],
              },
            },
            22,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.writeProjectConfiguration).toHaveBeenCalledWith(
      new Uint8Array(32).fill(7),
      "フォントサイズ:18\n",
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 21, outcome: "commit" },
      },
      undefined,
    );
    expect(bridge.restartProject).not.toHaveBeenCalled();
  });

  it("commits hot project-file settings for this session without writing the package", async () => {
    let messageId = 30;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(4, 5, "16"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    expect(store.configurationReadOnly).toBe(true);
    expect(store.configurationSessionOnly).toBe(true);

    const saving = store.savePreferences(defaultPreferences(), [{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "フォントサイズ:18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 4,
              expected_source_digest: new Uint8Array(32).fill(5),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            31,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: projectConfigurationReport(4, 6, "18").configuration },
            32,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.writeProjectConfiguration).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 31, outcome: "commit" },
      },
      undefined,
    );
    expect(store.status).toContain("退出游戏后将丢失");
    expect(store.configurationEntries[0]?.effective_value).toBe("18");
  });

  it("rejects non-hot project-file changes before starting a Runtime transaction", async () => {
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 7,
            source_digest: new Uint8Array(32).fill(8),
            restart_pending: false,
            entries: [
              {
                code: "AutoSave",
                japanese: "自動保存",
                english: "Auto save",
                value: "YES",
                effective_value: "YES",
                default_value: "YES",
                application: "restart",
                kind: "boolean",
                allowed: [],
                fixed: false,
                applicability: 8,
              },
              {
                code: "FontSize",
                japanese: "フォントサイズ",
                english: "Font size",
                value: "16",
                effective_value: "16",
                default_value: "16",
                application: "hot",
                kind: "integer",
                allowed: [],
                fixed: true,
                applicability: 8,
              },
            ],
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    bridge.submitRuntime.mockClear();

    for (const change of [
      { code: "AutoSave", value: "NO" },
      { code: "FontSize", value: "18" },
      { code: "UnknownDisplaySetting", value: "1" },
    ]) {
      await store.savePreferences(defaultPreferences(), [change]);
      expect(store.settingsError).toContain("仅支持当前会话内即时生效的设置");
    }

    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    expect(bridge.writeProjectConfiguration).not.toHaveBeenCalled();
  });

  it("aborts a prepared transaction when the host write fails and does not hot-apply it", async () => {
    let messageId = 40;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.writeProjectConfiguration.mockRejectedValueOnce(new Error("disk full"));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(5, 6, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    bridge.applyProjectConfiguration.mockClear();
    const saving = store.savePreferences(defaultPreferences(), [{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "フォントサイズ:18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 5,
              expected_source_digest: new Uint8Array(32).fill(6),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            41,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: projectConfigurationReport(5, 6, "12").configuration },
            42,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 41, outcome: "abort" },
      },
      undefined,
    );
    expect(bridge.applyProjectConfiguration).not.toHaveBeenCalled();
    expect(store.settingsError).toContain("disk full");
  });

  it("clears a rejected finalization so a later save can start", async () => {
    let messageId = 60;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(8, 9, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    const firstSave = store.savePreferences(defaultPreferences(), [
      { code: "FontSize", value: "18" },
    ]);
    await Promise.resolve();
    const contents = "フォントサイズ:18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 8,
              expected_source_digest: new Uint8Array(32).fill(9),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            61,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "finalize rejected" }, 62)],
      });
    await vi.advanceTimersByTimeAsync(64);
    await firstSave;
    expect(store.settingsError).toContain("finalize rejected");

    void store.savePreferences(defaultPreferences(), [{ code: "FontSize", value: "20" }]);
    await Promise.resolve();

    const prepareCalls = bridge.submitRuntime.mock.calls.filter(
      (call: unknown[]) => (call[0] as any).type === "prepare_configuration_update",
    );
    expect(prepareCalls).toHaveLength(2);
  });

  it("uses the browser close gesture for the WASM exit action", async () => {
    bridge.kind = "browser";
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const store = useRuntimeStore();

    await store.shutdown();

    expect(close).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status).toContain("请手动关闭此标签页");
  });

  it("uses the TUI snapshot filename format in local time", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 0, 30, 7));
    const store = useRuntimeStore();

    await store.exportSnapshot();

    expect(store.testTransferState()).toMatchObject({
      export: { name: "runtime_20260730-003007.snapshot" },
    });
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "normal" },
      },
      undefined,
    );
  });

  it("streams a titled project file through the host export boundary", async () => {
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "测试项目",
            history: { logical_lines: [] },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_export_ready", {
            result: { type: "ready", transfer: { transfer_id: 7, total_bytes: 3 } },
          }),
          runtimeEvent("state_export_chunk", { offset: 0, data: [1, 2, 3], complete: true }),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.beginProjectFileExport).toHaveBeenCalledWith("测试项目.reraproj");
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(bridge.writeProjectFileChunk).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3), true, true);
  });

  it("publishes input waits while the compiled cache is still being persisted", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    expect(bridge.writeCompiledCacheChunk).toHaveBeenCalledOnce();
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(1);
    expect(store.canInteract).toBe(true);
    await store.skip();
    expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
      {
        type: "input",
        value: expect.objectContaining({
          wait_id: 17,
          token: { epoch: 2, id: 5 },
          intent: { type: "enter" },
          message_skip: true,
        }),
      },
      undefined,
    );

    cacheWrite.resolve();
    await flushMicrotasks();
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(2);
  });

  it("allows only one in-flight submission for every active input wait", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "input gate",
          history: { logical_lines: [] },
          input_wait: wait,
        }),
        runtimeEvent("wait_changed", { type: "opened", value: wait }),
      ],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    bridge.submitRuntime.mockClear();

    store.prompt = "412";
    const first = store.submitText();
    const duplicateText = store.submitText();
    const duplicateButton = store.activate({ epoch: 2, id: 99 });
    await Promise.all([first, duplicateText, duplicateButton]);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as unknown[] | undefined)?.[0]).toMatchObject({
      value: {
        wait_id: 17,
        token: { epoch: 2, id: 5 },
        intent: { type: "commit_text", value: "412" },
      },
    });
    expect(store.canInteract).toBe(false);
  });

  it("shares the active-wait lock across text, buttons, left click, and right click", async () => {
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();

    await Promise.all([
      store.continueFromViewport(),
      store.skip(),
      store.submitText(),
      store.activate({ epoch: 2, id: 99 }),
    ]);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as unknown[] | undefined)?.[0]).toMatchObject({
      value: { wait_id: 17, intent: { type: "enter" }, message_skip: false },
    });
  });

  it("releases the input lock when a wait closes or is updated to a new identity", async () => {
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();

    await store.continueFromViewport();
    expect(store.canInteract).toBe(false);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
    });
    await vi.advanceTimersByTimeAsync(32);

    const nextWait = {
      kind: "enter_key",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "opened", value: nextWait })],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);

    await store.continueFromViewport();
    expect(store.canInteract).toBe(false);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "updated",
          value: {
            ...nextWait,
            wait_id: 19,
            submission_token: { epoch: 2, id: 7 },
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
  });

  it("unlocks a rejected wait, isolates late rejections, and accepts the next wait", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "1";
    await store.submitText();
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "invalid input" }, 10)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    await store.submitText();

    const nextWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        runtimeEvent("command_rejected", { message: "late old rejection" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    store.prompt = "2";
    await store.submitText();

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 17, 18]);
  });

  it("unlocks the active wait after a transport submission failure", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockReset();
    bridge.submitRuntime.mockRejectedValueOnce(new Error("transport failed"));
    store.prompt = "1";

    await expect(store.submitText()).rejects.toThrow("transport failed");
    expect(store.canInteract).toBe(true);
    bridge.submitRuntime.mockResolvedValueOnce(11);
    await store.submitText();
    expect(store.canInteract).toBe(false);
  });

  it("retries one correlated timed-wait race on the next wait of the same kind", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
      deadline_ns: 1_000_000_000,
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "412";
    await store.submitText();

    const nextWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
      deadline_ns: 1_100_000_000,
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 18]);
    expect((inputs[1] as unknown[] | undefined)?.[0]).toMatchObject({
      value: { intent: { type: "commit_text", value: "412" }, message_skip: false },
    });
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      false,
    );
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 11)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(2);
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(store.canInteract).toBe(true);
  });

  it("does not advance a timed wait beside input and resumes timing after rejection", async () => {
    let nextMessageId = 20;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
      deadline_ns: 1_000_000_000,
    });
    nextMessageId = 20;
    bridge.submitRuntime.mockClear();
    store.prompt = "1";
    await store.submitText();
    await vi.advanceTimersByTimeAsync(64);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      ),
    ).toHaveLength(0);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "invalid input" }, 20)],
    });
    await vi.advanceTimersByTimeAsync(64);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("serializes undo with active-wait input and unlocks it on rejection", async () => {
    let nextMessageId = 30;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait(
      {
        kind: "integer_value",
        wait_id: 17,
        submission_token: { epoch: 2, id: 5 },
      },
      [runtimeEvent("input_undo_state_changed", { token: { epoch: 2, id: 9 } })],
    );
    bridge.submitRuntime.mockClear();

    await Promise.all([store.undo(), store.undo(), store.submitText()]);
    expect(bridge.submitRuntime.mock.calls.map((call: unknown[]) => (call[0] as any).type)).toEqual(
      ["input_undo_request"],
    );
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "undo rejected" }, 30)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    store.prompt = "2";
    await store.submitText();
    expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );
  });

  it("filters only correlated stale projection rejections", async () => {
    let nextMessageId = 40;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    bridge.pump.mockResolvedValueOnce(emptyBatch()).mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "command_rejected",
          { message: "projection observation does not match the canonical presentation" },
          40,
        ),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 999),
        runtimeEvent(
          "command_rejected",
          { message: "projection observation does not match the canonical presentation" },
          998,
        ),
      ],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await store.projectViewport({
      width: 100,
      height: 80,
      lineColumns: 20,
      chromeWidth: 0,
      chromeHeight: 0,
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logs.filter((entry) =>
        entry.message.includes("projection observation does not match the canonical presentation"),
      ),
    ).toHaveLength(1);
  });

  it("cancels a pending compiled-cache writer before restarting the project", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    const restarting = store.restart();
    await flushMicrotasks();

    expect(bridge.cancelCompiledCacheExport).not.toHaveBeenCalled();
    expect(bridge.createSession).toHaveBeenCalledOnce();

    cacheWrite.resolve();
    await restarting;

    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(bridge.cancelCompiledCacheExport.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createSession.mock.invocationCallOrder[1]!,
    );
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(1);
  });

  it("cleans up a rejected compiled-cache write without requesting another chunk", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    cacheWrite.reject(undefined);
    await flushMicrotasks();

    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(store.testTransferState().export).toBeNull();
    expect(store.logs.at(-1)?.message).toContain("项目文件生成失败");
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(1);
  });

  it("exports the TUI-compatible diagnosis archive while locking game interaction", async () => {
    vi.setSystemTime(new Date(2026, 6, 29, 14, 5, 6));
    const stopWait = {
      kind: "integer_value",
      wait_id: 1,
      submission_token: { epoch: 2, id: 3 },
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "eraThe World",
            history: { logical_lines: [] },
          }),
          runtimeEvent("wait_changed", { type: "opened", value: stopWait }),
          runtimeEvent("log", { level: "info", message: "diagnostic detail" }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_export_ready", {
            result: { type: "ready", transfer: { transfer_id: 11, total_bytes: 2 } },
          }),
          runtimeEvent("state_export_chunk", { offset: 0, data: [1, 2], complete: true }),
          runtimeEvent("state_export_ready", {
            result: { type: "ready", transfer: { transfer_id: 12, total_bytes: 2 } },
          }),
          runtimeEvent("state_export_chunk", { offset: 0, data: [3, 4], complete: true }),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.canInteract).toBe(true);
    expect(store.canExportDiagnosis).toBe(true);

    await store.exportDiagnosis();
    expect(store.diagnosisExporting).toBe(true);
    expect(store.canInteract).toBe(false);
    expect(store.promptPlaceholder).toBe("诊断信息导出中……");
    expect(store.diagnosisNotification).toBe("诊断信息导出中……");
    await store.activate({ epoch: 2, id: 5 });
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );

    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "diagnosis" },
      },
      undefined,
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "compiled_project_cache", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(bridge.saveDiagnosis).toHaveBeenCalledWith(
      "eraThe World-diagnosis_20260729-140506.tar.zst",
      expect.objectContaining({
        projectName: "eraThe World",
        snapshot: Uint8Array.of(1, 2),
        compiledArtifact: Uint8Array.of(3, 4),
        logs: expect.stringContaining("INFO  diagnostic detail"),
      }),
    );
    expect(store.diagnosisExporting).toBe(false);
    expect(store.canInteract).toBe(true);
    expect(store.diagnosisNotification).toContain("诊断信息已导出");
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.diagnosisNotification).toBe("");
  });

  it("starts a test new game with the configured deterministic seed", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.openProject.mockResolvedValue({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: true,
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
    });
    const store = useRuntimeStore();
    store.configureTestRun({ start: { type: "new_game", seed: 42 } });

    await store.enableDebug();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "start",
        value: { mode: { type: "new_game", seed: 42 } },
      },
      undefined,
    );
  });

  it("advances deadline waits from the frontend monotonic clock without user input", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    const wait = {
      kind: "void",
      wait_id: 17,
      submission_token: { epoch: 2, id: 4 },
      deadline_ns: 11_000_000,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("wait_changed", { type: "opened", value: wait }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
      });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "new_game", seed: 42 },
      monotonicStartNs: 1_000_000,
    });

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "advance_time",
        value: { monotonic_time_ns: 1_000_000 },
      },
      undefined,
    );
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );

    await vi.advanceTimersByTimeAsync(32);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        (call) => (call as unknown as [{ type?: string }])[0]?.type === "advance_time",
      ),
    ).toHaveLength(1);
  });

  it("imports a traditional save before starting the test runtime", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    bridge.openProject.mockResolvedValue({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: true,
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [] }),
        runtimeEvent("state_import_accepted", { transfer_id: 9 }),
        runtimeEvent("state_import_ready", { transfer_id: 9, kind: "traditional_save" }),
      ],
    });
    const store = useRuntimeStore();
    store.configureTestRun({
      start: { type: "traditional_save", bytes: new Uint8Array([1, 2, 3]) },
    });

    await store.enableDebug();

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_import_begin",
        value: expect.objectContaining({ kind: "traditional_save", total_bytes: 3 }),
      }),
      undefined,
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "start", value: { mode: { type: "traditional_save", transfer_id: 9 } } },
      undefined,
    );
  });

  it("exports only an occupied browser save slot", async () => {
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("export");
    expect(store.traditionalSaveSlots).toEqual([
      { slot: 0, occupied: false },
      { slot: 1, occupied: true },
    ]);

    await store.confirmTraditionalSaveTransfer(0);
    expect(bridge.traditionalSaves.exportSlot).not.toHaveBeenCalled();

    await store.confirmTraditionalSaveTransfer(1);
    expect(bridge.traditionalSaves.exportSlot).toHaveBeenCalledWith(1);
    expect(store.status).toBe("已导出 save01.sav");
    expect(store.traditionalSaveDialogMode).toBeNull();
  });

  it("validates an imported save before asking to overwrite an occupied slot", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    bridge.traditionalSaves.pickImport.mockResolvedValue({ name: "incoming.sav", bytes });
    bridge.traditionalSaves.listSlots
      .mockResolvedValueOnce([{ slot: 0, occupied: true }])
      .mockResolvedValueOnce([{ slot: 0, occupied: true }]);
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("import");
    await store.pickTraditionalSaveImport();
    await store.confirmTraditionalSaveTransfer(0);

    expect(bridge.traditionalSaves.inspect).toHaveBeenCalledWith(bytes);
    expect(bridge.traditionalSaves.writeSlot).not.toHaveBeenCalled();
    expect(store.traditionalSaveOverwriteSlot).toBe(0);

    await store.confirmTraditionalSaveOverwrite();

    expect(bridge.traditionalSaves.writeSlot).toHaveBeenCalledWith(0, bytes);
    expect(store.status).toBe("已导入 save00.sav");
    expect(store.traditionalSaveDialogMode).toBeNull();
  });

  it("keeps the import dialog open when runtime validation rejects a save", async () => {
    bridge.traditionalSaves.pickImport.mockResolvedValue({
      name: "broken.sav",
      bytes: Uint8Array.of(9),
    });
    bridge.traditionalSaves.inspect.mockRejectedValue(new Error("traditional save is invalid"));
    const store = await runningBrowserStore();

    await store.openTraditionalSaveDialog("import");
    await store.pickTraditionalSaveImport();
    await store.confirmTraditionalSaveTransfer(0);

    expect(bridge.traditionalSaves.writeSlot).not.toHaveBeenCalled();
    expect(store.traditionalSaveTransferError).toContain("traditional save is invalid");
    expect(store.traditionalSaveDialogMode).toBe("import");
  });

  it("recreates the runtime and reopens the same project for Restart", async () => {
    bridge.kind = "browser";
    bridge.listFonts.mockResolvedValue({ kind: "ready", fonts: ["Late Browser Font"] });
    const store = useRuntimeStore();
    store.projectOpen = true;
    bridge.restartProject.mockImplementationOnce(async () => {
      expect(store.startupTelemetry).toMatchObject({ outcome: "loading", client: "browser" });
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 1,
        cacheReadMs: 2,
        sourceReadMs: 0,
        submitMs: 3,
        cacheImported: true,
      };
    });

    await store.restart();

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.createSession.mock.calls[0]![0].availableFonts).toEqual([
      "system-ui",
      "sans-serif",
      "serif",
      "monospace",
    ]);
    await store.requestSystemFonts();
    expect(store.systemFonts).toEqual(["Late Browser Font"]);
    expect(bridge.createSession.mock.calls[0]![0].availableFonts).toEqual([
      "system-ui",
      "sans-serif",
      "serif",
      "monospace",
    ]);
    expect(bridge.restartProject).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" }),
      expect.anything(),
    );
  });

  it("confirms project replacement, clears the viewport, and blocks opening through compilation", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        resume = vi.fn(async () => {});
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    bridge.openProject.mockImplementation(async (onSubmitted?: (submittedAtMs: number) => void) => {
      onSubmitted?.(performance.now());
      bridge.projectProgressListener?.({ stage: "scanning", completed: 3, total: 4 });
      return {
        submittedAtMs: 0,
        quickScanMs: 1,
        cacheReadMs: 2,
        sourceReadMs: 3,
        submitMs: 4,
        cacheImported: true,
      };
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.presentation.lines.push({ id: "old-line", runs: [] } as any);

    await store.openProject();

    expect(store.openProjectConfirmationOpen).toBe(true);
    expect(bridge.openProject).not.toHaveBeenCalled();

    store.cancelOpenProject();
    expect(store.openProjectConfirmationOpen).toBe(false);
    expect(store.presentation.lines).toHaveLength(1);
    expect(store.projectOpen).toBe(true);

    await store.openProject();

    const replacement = store.confirmOpenProject();
    expect(store.openProjectConfirmationOpen).toBe(false);
    expect(store.presentation.lines).toHaveLength(0);
    expect(store.projectLoading).toBe(false);
    expect(store.canOpenProject).toBe(false);
    await replacement;

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.openProject).toHaveBeenCalledOnce();
    expect(store.projectOpen).toBe(true);
    expect(store.projectLoading).toBe(true);
    expect(store.canOpenProject).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("项目文件缓存命中，正在加载缓存…");
    expect(store.projectLoadProgressValue).toBeUndefined();

    bridge.projectProgressListener?.({ stage: "compiling", completed: 7, total: 10 });
    expect(store.projectLoadProgressLabel).toBe("正在编译脚本函数：7/10（70%）");
    expect(store.projectLoadProgressValue).toBe(70);

    bridge.projectProgressListener?.({ stage: "validating", completed: 1, total: 2 });
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%）");
    expect(store.projectLoadProgressValue).toBe(50);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.projectLoadProgressLabel).toBe("正在验证编译结果：1/2（50%） · 已等待 5 秒");

    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("project_load_report", {
            success: true,
            diagnostics: [
              { code: "runtime.compiled_cache_hit", level: "info", message: "cache hit" },
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_external", epoch: 2 })],
      });
    await vi.advanceTimersByTimeAsync(16);

    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.canOpenProject).toBe(true);
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "start", value: { mode: { type: "new_game", seed: null } } },
      undefined,
    );
    expect(store.startupTelemetry).toMatchObject({
      scenario: "warm",
      cacheHit: true,
      outcome: "success",
      bridge: { quickScanMs: 1, cacheReadMs: 2, sourceReadMs: 3, submitMs: 4 },
    });
    expect(store.startupTelemetry?.observedStages.scanning).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.runtimeValidationReportedMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.frontendReadyToStartMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.startSubmittedMs).toBeTypeOf("number");
    expect(store.startupTelemetry?.milestones.firstGamePhaseMs).toBeTypeOf("number");
  });

  it("terminates startup telemetry when a bridge fails after submission", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(async (onSubmitted?: (submittedAtMs: number) => void) => {
      onSubmitted?.(performance.now());
      throw new Error("scan failed");
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toMatchObject({
      scenario: "cold",
      outcome: "failure",
      error: "Error: scan failed",
    });
  });

  it("does not wait for browser audio unlock before opening a project", async () => {
    const resume = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        destination = {};
        resume = resume;
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    bridge.openProject.mockResolvedValue({
      submittedAtMs: performance.now(),
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(resume).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(bridge.openProject).toHaveBeenCalledOnce();
  });

  it("does not create a startup attempt when project selection is cancelled", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockResolvedValue(undefined);
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toBeUndefined();
  });

  it("classifies a rejected cache followed by source submission as cold", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(async (onSubmitted?: (submittedAtMs: number) => void) => {
      onSubmitted?.(performance.now());
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 1,
        cacheReadMs: 2,
        sourceReadMs: 0,
        submitMs: 3,
        cacheImported: true,
      };
    });
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("project_load_report", {
            success: false,
            payload_required: true,
            diagnostics: [],
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(64);

    expect(bridge.submitProjectSource).toHaveBeenCalledOnce();
    expect(store.startupTelemetry).toMatchObject({
      scenario: "cold",
      cacheHit: false,
      outcome: "success",
    });
  });

  it("fails the active attempt when Runtime rejects its Start command", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(async (onSubmitted?: (submittedAtMs: number) => void) => {
      onSubmitted?.(performance.now());
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 1,
        cacheReadMs: 0,
        sourceReadMs: 1,
        submitMs: 1,
        cacheImported: false,
      };
    });
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "start rejected" }, 1)],
      });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(32);

    expect(store.startupTelemetry).toMatchObject({
      outcome: "failure",
      error: "start rejected",
    });
  });

  it("keeps Firefox and Safari directory copying visible through the build handoff", async () => {
    bridge.kind = "browser";
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        resume = vi.fn(async () => {});
        createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
      },
    );
    let resolveOpenProject!: (metrics: {
      submittedAtMs: number;
      quickScanMs: number;
      cacheReadMs: number;
      sourceReadMs: number;
      submitMs: number;
      cacheImported: boolean;
    }) => void;
    bridge.openProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpenProject = resolve;
        }),
    );
    const store = useRuntimeStore();

    const opening = store.openProject();
    await vi.waitFor(() => expect(bridge.openProject).toHaveBeenCalledOnce());
    expect(store.projectLoading).toBe(false);

    bridge.projectProgressListener?.({ stage: "importing", completed: 12, total: 40 });
    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("正在复制项目文件：12/40（30%）");
    expect(store.projectLoadProgressValue).toBe(30);

    bridge.projectProgressListener?.({ stage: "scanning", completed: 40, total: 40 });
    expect(store.projectLoadProgressLabel).toBe("正在读取项目文件：40/40（100%）");

    resolveOpenProject({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 3,
      submitMs: 4,
      cacheImported: false,
    });
    await opening;

    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("项目文件读取完成，正在准备编译与校验…");
    expect(store.projectLoadProgressValue).toBeUndefined();
  });

  it("attaches without pausing and retries a requested pause with a renewed grant", async () => {
    const oldToken = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const newToken = { grant_id: { high: 1, low: 2 }, program_generation: 2 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: oldToken }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent("grant", { token: newToken }),
          runtimeEvent("log", {
            level: "warning",
            message:
              "debug request failed [PermissionDenied]: debug grant is stale or belongs to another session generation",
          }),
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(1);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
    expect(store.singleStepEnabled).toBe(false);

    await store.openDebugDialog("variables");
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: oldToken, command: { type: "pause" } },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: newToken, command: { type: "pause" } },
    });
    expect(store.logs).toEqual([]);
  });

  it("continues after the last debugger surface closes without enabling single-step mode", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            { stop, selected_fiber: 7, reason: { type: "pause_requested" } },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 4),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.openDebugDialog("console");
    expect(store.singleStepEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(16);

    const closing = store.closeDebugDialog("console");
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant, command: { type: "continue", stop } },
    });
    await vi.advanceTimersByTimeAsync(16);
    await closing;

    expect(store.debugConsoleOpen).toBe(false);
    expect(store.singleStepEnabled).toBe(false);
    expect(store.debugStop).toBeNull();
  });

  it("renegotiates when the runtime rejects the current grant", async () => {
    const token = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
  });

  it("loads open debugger surfaces after stopping and selects a populated call stack", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            {
              stop,
              selected_fiber: 7,
              reason: { type: "pause_requested" },
              source: { relative_path: "erb/debug.erb", line: 3 },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "variable_page",
              value: {
                stop,
                variables: [
                  {
                    symbol_key: [1],
                    name: "RESULT",
                    storage: "global",
                    value_kind: "integer",
                    dimensions: [],
                  },
                ],
              },
            },
            4,
          ),
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "debug_paused", frame_count: 2 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "call_stack",
              value: {
                stop,
                fiber_id: 7,
                frames: [{ frame_id: 9, function_name: "EVENTFIRST", instruction: 12 }],
              },
            },
            5,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.openDebugDialog("variables");
    await store.openDebugDialog("stack");
    await vi.advanceTimersByTimeAsync(48);

    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_variables", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_fibers", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "read_call_stack", stop, fiber_id: 7 } },
    });
    expect(store.debugVariables.map((variable) => variable.name)).toEqual(["RESULT"]);
    expect(store.debugFibers.map((fiber) => fiber.fiber_id)).toEqual([7]);
    expect(store.debugFrames.map((frame) => frame.function_name)).toEqual(["EVENTFIRST"]);
  });

  it("steps only runnable fibers and restores the stop when the runtime rejects the step", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            {
              stop,
              selected_fiber: 7,
              reason: { type: "pause_requested" },
              source: { relative_path: "erb/debug.erb", line: 3 },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "waiting_host", frame_count: 1 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            { code: "invalid_state", message: "only a runnable fiber can be stepped" },
            4,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(32);

    expect(store.canStepDebug).toBe(false);
    await store.toggleSingleStep();
    expect(store.promptPlaceholder).toBe("单步暂停：erb/debug.erb:4（F10 继续）");
    store.debugFibers = [{ fiber_id: 7, state: "runnable", frame_count: 1 }];
    expect(store.canStepDebug).toBe(true);

    const stepping = store.stepDebug();
    const rejectedStep = expect(stepping).rejects.toThrow("only a runnable fiber can be stepped");
    await vi.advanceTimersByTimeAsync(16);
    await rejectedStep;
    expect(store.debugStop).toEqual(expect.objectContaining({ stop }));
  });

  it("uses the newest envelope epoch across presentation snapshots", async () => {
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "presentation_snapshot",
          {
            revision: 1,
            title: "first",
            history: { logical_lines: [] },
          },
          undefined,
          8,
        ),
        runtimeEvent(
          "presentation_snapshot",
          {
            revision: 2,
            title: "title",
            history: { logical_lines: [] },
          },
          undefined,
          9,
        ),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.runtimeEpoch).toBe(9);
  });

  it("keeps the previous frame visible until a redraw-disabled replacement reaches a wait", async () => {
    const line = (lineId: number, text: string) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [{ type: "text", text, style: {} }],
    });
    const firstWait = {
      kind: "integer_value",
      wait_id: 10,
      submission_token: { epoch: 2, id: 10 },
      deadline_ns: 1_000_000_000,
    };
    const nextWait = {
      ...firstWait,
      wait_id: 11,
      submission_token: { epoch: 2, id: 11 },
      deadline_ns: 2_000_000_000,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "map",
            history: { logical_lines: [line(1, "frame 1")] },
            input_wait: firstWait,
            redraw: { enabled: true },
          }),
          runtimeEvent("wait_changed", { type: "opened", value: firstWait }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("wait_changed", { type: "closed", value: null }),
          runtimeEvent("presentation_delta", {
            base_revision: 1,
            new_revision: 2,
            operations: [
              { type: "set_input_wait", input_wait: null },
              { type: "set_redraw", redraw: { enabled: false } },
              { type: "delete_lines", count: 1 },
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("presentation_delta", {
            base_revision: 2,
            new_revision: 3,
            operations: [
              { type: "append_line", line: line(2, "frame 2") },
              { type: "set_input_wait", input_wait: nextWait },
            ],
          }),
          runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        ],
      });
    const store = useRuntimeStore();

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.presentation.revision).toBe(1);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 1");
    const historyRevision = store.presentation.historyRevision;

    await vi.advanceTimersByTimeAsync(16);
    expect(store.presentation.revision).toBe(1);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 1");
    expect(store.canInteract).toBe(false);

    await vi.advanceTimersByTimeAsync(16);
    expect(store.presentation.revision).toBe(3);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 2");
    expect(store.presentation.historyRevision).toBe(historyRevision);
    expect(store.canInteract).toBe(true);
  });

  it("publishes hot-setting deltas at an existing redraw-disabled input wait", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 12,
      submission_token: { epoch: 2, id: 12 },
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "settings wait",
            history: { logical_lines: [] },
            input_wait: wait,
            redraw: { enabled: false },
            settings: { line_height: 18_000 },
          }),
          runtimeEvent("wait_changed", { type: "opened", value: wait }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("presentation_delta", {
            base_revision: 1,
            new_revision: 2,
            operations: [{ type: "set_settings", settings: { line_height: 19_000 } }],
          }),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.canInteract).toBe(true);

    await vi.advanceTimersByTimeAsync(16);

    expect(store.presentation.revision).toBe(2);
    expect(store.presentation.settings.line_height).toBe(19_000);
    expect(store.presentation.inputWait).toEqual(wait);
    expect(store.canInteract).toBe(true);
    expect(store.promptPlaceholder).toBe("输入内容；Enter 提交");
  });
});

async function runningBrowserStore() {
  bridge.pump.mockResolvedValueOnce({
    ...emptyBatch(),
    events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
  });
  const store = useRuntimeStore();
  store.projectOpen = true;
  await store.enableDebug();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.canManageTraditionalSaves).toBe(true);
  return store;
}

async function storeWithPendingCompiledCacheWrite(write: Promise<void>) {
  stubRunningAudioContext();
  bridge.writeCompiledCacheChunk.mockReturnValueOnce(write);
  bridge.openProject.mockResolvedValue({
    submittedAtMs: 0,
    quickScanMs: 1,
    cacheReadMs: 0,
    sourceReadMs: 1,
    submitMs: 1,
    cacheImported: false,
  });
  let reportSent = false;
  let readySent = false;
  let chunkSent = false;
  bridge.pump.mockImplementation(async () => {
    if (!reportSent) {
      reportSent = true;
      return {
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      };
    }
    const commands = bridge.submitRuntime.mock.calls.map(
      ([message]: unknown[]) => (message as { type?: string }).type,
    );
    if (!readySent && commands.includes("state_export_request")) {
      readySent = true;
      return {
        ...emptyBatch(),
        events: [
          runtimeEvent("state_export_ready", {
            result: { type: "ready", transfer: { transfer_id: 7, total_bytes: 6 } },
          }),
        ],
      };
    }
    if (!chunkSent && commands.includes("state_export_chunk_request")) {
      chunkSent = true;
      return {
        ...emptyBatch(),
        events: [
          runtimeEvent("state_export_chunk", { offset: 0, data: [1, 2, 3], complete: false }),
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("wait_changed", {
            type: "opened",
            value: {
              kind: "enter_key",
              wait_id: 17,
              submission_token: { epoch: 2, id: 5 },
            },
          }),
        ],
      };
    }
    return emptyBatch();
  });
  const store = useRuntimeStore();

  await store.openProject();
  await vi.advanceTimersByTimeAsync(1_100);
  expect(bridge.writeCompiledCacheChunk).toHaveBeenCalledOnce();
  return store;
}

async function storeWithInputWait(
  wait: Record<string, unknown>,
  extraEvents: ReturnType<typeof runtimeEvent>[] = [],
) {
  bridge.pump.mockResolvedValueOnce({
    ...emptyBatch(),
    events: [
      runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      runtimeEvent("presentation_snapshot", {
        revision: 1,
        title: "input gate",
        history: { logical_lines: [] },
        input_wait: wait,
      }),
      runtimeEvent("wait_changed", { type: "opened", value: wait }),
      ...extraEvents,
    ],
  });
  const store = useRuntimeStore();
  store.projectOpen = true;
  await store.enableDebug();
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

function runtimeEvent(type: string, value: unknown, correlationId?: number, epoch?: number) {
  return {
    channel: "runtime" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    epoch,
    message: { type, value },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function projectConfigurationReport(revision: number, digestByte: number, fontSize: string) {
  return {
    success: true,
    diagnostics: [],
    configuration: {
      project_revision: revision,
      source_digest: new Uint8Array(32).fill(digestByte),
      restart_pending: false,
      entries: [
        {
          code: "FontSize",
          japanese: "フォントサイズ",
          english: "Font size",
          value: fontSize,
          effective_value: fontSize,
          default_value: "18",
          application: "hot",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
      ],
    },
  };
}

function debugEvent(type: string, value: unknown, correlationId?: number) {
  return {
    channel: "debug" as const,
    sequence: 0,
    messageId: 0,
    correlationId,
    message: { type, value },
  };
}
