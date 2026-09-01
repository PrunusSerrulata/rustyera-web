import { blake3 } from "@noble/hashes/blake3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const streamDiagnosisArchiveInWorker = vi.hoisted(() => vi.fn());
const currentWindow = vi.hoisted(() => ({
  close: vi.fn(),
  setResizable: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  isMaximized: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => currentWindow }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));
vi.mock("@/platform/diagnosis", () => ({ streamDiagnosisArchiveInWorker }));

import { TauriBridge } from "@/platform/tauriBridge";
import { configureServiceLifecycle } from "@/testing/serviceLifecycle";
import { sfntFont } from "./fontFixture";

function mockNativeProject(metrics: Record<string, unknown>): void {
  invoke.mockImplementation(async (command) => (command === "project_font_sources" ? [] : metrics));
}

function commandCalls(command: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === command);
}

describe("Tauri project restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockReset();
    listen.mockResolvedValue(vi.fn());
    currentWindow.setResizable.mockResolvedValue(undefined);
    currentWindow.setSize.mockResolvedValue(undefined);
    currentWindow.setPosition.mockResolvedValue(undefined);
    currentWindow.isMaximized.mockResolvedValue(false);
    currentWindow.maximize.mockResolvedValue(undefined);
    currentWindow.unmaximize.mockResolvedValue(undefined);
    streamDiagnosisArchiveInWorker.mockReset();
  });

  afterEach(() => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({});
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.__RUSTYERA_TEST_DOWNLOADS__ = undefined;
    Reflect.deleteProperty(document, "fonts");
  });

  it("reopens the selected project path after runtime session recreation", async () => {
    const metrics = {
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
    };
    open.mockResolvedValue("/game/eraTW");
    mockNativeProject(metrics);
    const bridge = new TauriBridge();

    expect(bridge.snapshotRestoreMode).toBe("fresh_session");
    expect(bridge.runtimeMemoryCounters()).toEqual({
      workerGeneration: null,
      wasmLinearMemoryBytes: null,
      residentBytes: null,
      physicalFootprintBytes: null,
      virtualBytes: null,
      privateBytes: null,
      committedBytes: null,
      anonymousBytes: null,
    });
    expect(bridge.automaticCompiledCacheExport).toBe(true);
    await bridge.openProject();
    expect(bridge.fullProjectExportSupported()).toBe(true);
    await bridge.restartProject();

    expect(commandCalls("open_project")).toEqual([
      ["open_project", { path: "/game/eraTW" }],
      ["open_project", { path: "/game/eraTW" }],
    ]);
  });

  it("registers native project font bytes and exposes their family to settings", async () => {
    const added: Array<{ family: string }> = [];
    class TestFontFace {
      constructor(
        readonly family: string,
        readonly source: ArrayBuffer,
      ) {}
      async load() {
        return this;
      }
    }
    vi.stubGlobal("FontFace", TestFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: { family: string }) => added.push(face),
        delete: () => true,
      },
    });
    open.mockResolvedValue("/game/project");
    const bytes = sfntFont([{ nameId: 1, value: "Project Font" }]);
    invoke.mockImplementation(async (command) => {
      if (command === "open_project")
        return {
          quickScanMs: 1,
          cacheReadMs: 0,
          sourceReadMs: 0,
          submitMs: 1,
          cacheImported: false,
        };
      if (command === "project_font_sources")
        return [
          {
            relativePath: "font/Project.ttf",
            contentHash: [...blake3(bytes)],
            byteLength: bytes.byteLength,
          },
        ];
      if (command === "read_project_font") return bytes;
      return undefined;
    });
    const bridge = new TauriBridge();

    const metrics = await bridge.openProject();

    expect(metrics?.projectFonts).toEqual({ fonts: ["Project Font"], errors: [] });
    expect(added.map((face) => face.family)).toEqual(["Project Font"]);
  });

  it("returns native raw response bytes without rebuilding number arrays", async () => {
    const resource = Uint8Array.of(0, 0x80, 0xff);
    open.mockResolvedValue("/tmp/state.rerasnap");
    invoke.mockImplementation(async (command) => {
      if (command === "read_resource" || command === "read_import") return resource;
      return undefined;
    });
    const bridge = new TauriBridge();

    await expect(bridge.readResource("resources/image.png")).resolves.toBe(resource);
    await expect(bridge.openUpload()).resolves.toBe(resource);
  });

  it("tags storage write bytes and decodes the raw storage response", async () => {
    const response = new TextEncoder().encode(
      JSON.stringify({
        request_id: { $rustyeraInteger: "9007199254740992" },
        result: {
          type: "read",
          data: { $rustyeraBytes: "AID/" },
          revision: "digest",
        },
      }),
    );
    invoke.mockResolvedValueOnce(response.buffer);
    const bridge = new TauriBridge();

    await expect(
      bridge.handleStorage({
        request_id: 9_007_199_254_740_992n,
        namespace: "save",
        relative_path: "save01.sav",
        operation: {
          type: "write",
          data: Uint8Array.of(0, 0x80, 0xff),
          atomic_replace: true,
          precondition: { type: "revision", revision: "previous" },
        },
        idempotency_key: "write-save01",
        deadline_ns: 9_007_199_254_740_993n,
      }),
    ).resolves.toEqual({
      request_id: 9_007_199_254_740_992n,
      result: {
        type: "read",
        data: Uint8Array.of(0, 0x80, 0xff),
        revision: "digest",
      },
    });
    expect(invoke).toHaveBeenCalledWith("storage_request", {
      request: {
        request_id: { $rustyeraInteger: "9007199254740992" },
        namespace: "save",
        relative_path: "save01.sav",
        operation: {
          type: "write",
          data: { $rustyeraBytes: "AID/" },
          atomic_replace: true,
          precondition: { type: "revision", revision: "previous" },
        },
        idempotency_key: "write-save01",
        deadline_ns: { $rustyeraInteger: "9007199254740993" },
      },
    });
  });

  it("rejects restart before a project has been selected", async () => {
    await expect(new TauriBridge().restartProject()).rejects.toThrow("没有打开的项目");
  });

  it("forwards compiled-cache cancellation to the native host", async () => {
    invoke.mockResolvedValue(undefined);

    await new TauriBridge().cancelCompiledCacheExport();

    expect(invoke).toHaveBeenCalledWith("cancel_compiled_cache_export");
  });

  it("disposes native owners and listeners without closing the containing window", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    invoke.mockResolvedValue(undefined);
    const bridge = new TauriBridge();
    bridge.setProjectProgressListener(vi.fn());
    await Promise.resolve();

    await bridge.dispose();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("destroy_session");
    expect(currentWindow.close).not.toHaveBeenCalled();
  });

  it("tags project export chunks, including the empty completion write", async () => {
    save.mockResolvedValue("/tmp/project.reraproj");
    invoke.mockResolvedValue(undefined);
    const bridge = new TauriBridge();

    await bridge.beginProjectFileExport("project.reraproj");
    await bridge.writeProjectFileChunk(Uint8Array.of(0, 0x80, 0xff), true, false);
    await bridge.writeProjectFileChunk(new Uint8Array(), false, true);

    expect(commandCalls("write_export_chunk")).toEqual([
      [
        "write_export_chunk",
        {
          path: "/tmp/project.reraproj",
          bytes: { $rustyeraBytes: "AID/" },
          reset: true,
          complete: false,
        },
      ],
      [
        "write_export_chunk",
        {
          path: "/tmp/project.reraproj",
          bytes: { $rustyeraBytes: "" },
          reset: false,
          complete: true,
        },
      ],
    ]);
  });

  it("streams state exports through the native atomic writer", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    configureServiceLifecycle({ stateExportPath: "/tmp/state.snapshot" });
    invoke.mockResolvedValue(undefined);
    const bridge = new TauriBridge();

    await expect(bridge.beginStateExport("state.snapshot", 3)).resolves.toBe(true);
    await bridge.writeStateExportChunk(Uint8Array.of(1, 2, 3), true, false);
    await bridge.writeStateExportChunk(new Uint8Array(), false, true);

    expect(save).not.toHaveBeenCalled();

    expect(commandCalls("write_export_chunk")).toEqual([
      [
        "write_export_chunk",
        {
          path: "/tmp/state.snapshot",
          bytes: { $rustyeraBytes: "AQID" },
          reset: true,
          complete: false,
        },
      ],
      [
        "write_export_chunk",
        {
          path: "/tmp/state.snapshot",
          bytes: { $rustyeraBytes: "" },
          reset: false,
          complete: true,
        },
      ],
    ]);
  });

  it("tags compiled-cache chunks, including the empty completion write", async () => {
    invoke.mockResolvedValue(undefined);
    const bridge = new TauriBridge();

    await bridge.writeCompiledCacheChunk(Uint8Array.of(0, 0x80, 0xff), true, false);
    await bridge.writeCompiledCacheChunk(new Uint8Array(), false, true);

    expect(commandCalls("write_compiled_cache_chunk")).toEqual([
      [
        "write_compiled_cache_chunk",
        { bytes: { $rustyeraBytes: "AID/" }, reset: true, complete: false },
      ],
      [
        "write_compiled_cache_chunk",
        { bytes: { $rustyeraBytes: "" }, reset: false, complete: true },
      ],
    ]);
  });

  it("reports diagnosis completion only after the native host commits the file", async () => {
    const completed = deferred<void>();
    save.mockResolvedValue("/tmp/diagnosis.tar.zst");
    invoke.mockImplementation(async (command, arguments_) => {
      if (command === "write_export_chunk" && arguments_?.complete === true)
        await completed.promise;
      return undefined;
    });
    streamDiagnosisArchiveInWorker.mockImplementation(
      async (
        _input: unknown,
        write: (chunk: Uint8Array) => Promise<void>,
        progress?: (value: { completed: number; total: number }) => void,
      ) => {
        await write(Uint8Array.of(0, 0x80, 0xff));
        progress?.({ completed: 1, total: 2 });
        return 2;
      },
    );
    const progress = vi.fn();

    const saving = new TauriBridge().saveDiagnosis("diagnosis.tar.zst", diagnosisInput(), progress);
    await flushMicrotasks();

    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 2 });
    expect(progress).not.toHaveBeenCalledWith({ completed: 2, total: 2 });
    completed.resolve();
    await expect(saving).resolves.toBe(true);
    expect(progress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
    expect(commandCalls("write_export_chunk")).toEqual([
      [
        "write_export_chunk",
        {
          path: "/tmp/diagnosis.tar.zst",
          bytes: { $rustyeraBytes: "AID/" },
          reset: true,
          complete: false,
        },
      ],
      [
        "write_export_chunk",
        {
          path: "/tmp/diagnosis.tar.zst",
          bytes: { $rustyeraBytes: "" },
          reset: false,
          complete: true,
        },
      ],
    ]);
  });

  it("publishes native export identity only after the actual archive is committed", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    vi.stubEnv("VITE_RUSTYERA_TAURI_EXPORT_PATH", "/tmp/fixed-fallback.tar.zst");
    configureServiceLifecycle({ diagnosisExportPath: "/tmp/identity.tar.zst" });
    const committed = deferred<void>();
    invoke.mockImplementation(async (command, args) => {
      if (command === "inspect_project_file_identity")
        return {
          projectRevision: 1,
          files: [
            {
              relativePath: "csv/GAMEBASE.CSV",
              category: "csv",
              contentHash: "a".repeat(64),
              payloadKind: "utf8",
              byteLength: 80,
            },
          ],
        };
      if (command === "write_export_chunk" && args.complete) await committed.promise;
    });
    streamDiagnosisArchiveInWorker.mockImplementation(async (input, write) => {
      // Match real Worker ownership transfer, which invalidates the caller's views.
      structuredClone(input, {
        transfer: [input.snapshot.buffer, input.projectFile.buffer, input.inputReplay.buffer],
      });
      await write(Uint8Array.of(1, 2));
      return 20;
    });
    const bridge = new TauriBridge();
    const pending = bridge.saveDiagnosis("identity.tar.zst", diagnosisInput());
    await flushMicrotasks();
    expect(window.__RUSTYERA_TEST_DOWNLOADS__).toBeUndefined();
    committed.resolve();
    await expect(pending).resolves.toBe(true);
    expect(window.__RUSTYERA_TEST_DOWNLOADS__?.at(-1)?.projectIdentity?.files[0].byteLength).toBe(
      80,
    );
    expect(save).not.toHaveBeenCalled();
    expect(commandCalls("inspect_project_file_identity")[0]?.[1]).toEqual({
      bytes: { $rustyeraBytes: "Aw==" },
    });
    expect(commandCalls("write_export_chunk")).toEqual([
      [
        "write_export_chunk",
        {
          path: "/tmp/identity.tar.zst",
          bytes: { $rustyeraBytes: "AQI=" },
          reset: true,
          complete: false,
        },
      ],
      [
        "write_export_chunk",
        {
          path: "/tmp/identity.tar.zst",
          bytes: { $rustyeraBytes: "" },
          reset: false,
          complete: true,
        },
      ],
    ]);
    await expect(bridge.saveDiagnosis("fallback.tar.zst", diagnosisInput())).resolves.toBe(true);
    expect(commandCalls("write_export_chunk").at(-1)?.[1]).toMatchObject({
      path: "/tmp/fixed-fallback.tar.zst",
      complete: true,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("consumes a failed diagnosis destination and publishes no false download", async () => {
    vi.stubEnv("VITE_RUSTYERA_TEST", "1");
    vi.stubEnv("VITE_RUSTYERA_TAURI_EXPORT_PATH", "");
    configureServiceLifecycle({ diagnosisExportPath: "/tmp/failed.tar.zst" });
    invoke.mockRejectedValueOnce(new Error("native identity inspection failed"));
    const bridge = new TauriBridge();
    await expect(bridge.saveDiagnosis("failed.tar.zst", diagnosisInput())).rejects.toThrow(
      "native identity inspection failed",
    );
    expect(commandCalls("cancel_export")).toHaveLength(1);
    expect(commandCalls("write_export_chunk")).toHaveLength(0);
    expect(streamDiagnosisArchiveInWorker).not.toHaveBeenCalled();
    expect(window.__RUSTYERA_TEST_DOWNLOADS__).toBeUndefined();
    save.mockResolvedValue(undefined);
    await expect(bridge.saveDiagnosis("next.tar.zst", diagnosisInput())).resolves.toBe(false);
    expect(save).toHaveBeenCalledWith({ defaultPath: "next.tar.zst" });
  });

  it("keeps the previous project when opening a replacement fails", async () => {
    open.mockResolvedValueOnce("/game/old").mockResolvedValueOnce("/game/broken");
    invoke.mockImplementation(async (command, arguments_) => {
      if (command === "project_font_sources") return [];
      if (command === "open_project" && arguments_?.path === "/game/broken")
        throw new Error("compile failed");
      return { cacheImported: true };
    });
    const bridge = new TauriBridge();

    await bridge.openProject();
    await expect(bridge.openProject()).rejects.toThrow("compile failed");
    await bridge.restartProject();

    expect(bridge.projectName()).toBe("old");
    expect(commandCalls("open_project").at(-1)).toEqual(["open_project", { path: "/game/old" }]);
  });

  it("reopens a selected project file through the packaged-project command", async () => {
    open.mockResolvedValue("/game/eraTW.reraproj");
    mockNativeProject({ cacheImported: true });
    const bridge = new TauriBridge();

    await bridge.openProjectFile();
    expect(bridge.fullProjectExportSupported()).toBe(true);
    await bridge.restartProject();

    expect(commandCalls("open_project_file")).toEqual([
      ["open_project_file", { path: "/game/eraTW.reraproj" }],
      ["open_project_file", { path: "/game/eraTW.reraproj" }],
    ]);
    expect(bridge.projectName()).toBe("eraTW");
    expect(bridge.projectConfigurationWritable()).toBe(true);
  });

  it("writes configuration only for an opened source directory", async () => {
    open.mockResolvedValue("/game/eraTW");
    mockNativeProject({ cacheImported: false });
    const bridge = new TauriBridge();

    expect(bridge.projectConfigurationWritable()).toBe(false);
    await bridge.openProject();
    expect(bridge.projectConfigurationWritable()).toBe(true);
    await bridge.writeProjectConfiguration(Uint8Array.of(1, 2), "[text]\nfont_size = 18\n");

    expect(invoke).toHaveBeenLastCalledWith("write_project_configuration", {
      expectedDigest: [1, 2],
      contents: "[text]\nfont_size = 18\n",
    });
  });

  it("forwards native project progress events", async () => {
    let receive: ((event: { payload: unknown }) => void) | undefined;
    listen.mockImplementation(async (_name, callback) => {
      receive = callback;
      return vi.fn();
    });
    const progress = vi.fn();
    const bridge = new TauriBridge();

    bridge.setProjectProgressListener(progress);
    await Promise.resolve();
    receive?.({ payload: { stage: "compiling", completed: 9, total: 10 } });

    expect(progress).toHaveBeenCalledWith({ stage: "compiling", completed: 9, total: 10 });
  });

  it.each([
    ["directory", "openProject", "/game/eraTW"],
    ["file", "openProjectFile", "/game/eraTW.reraproj"],
  ] as const)(
    "submits and prepares the selected %s before native I/O",
    async (_kind, method, path) => {
      open.mockResolvedValue(path);
      mockNativeProject({
        quickScanMs: 1,
        cacheReadMs: 2,
        sourceReadMs: 3,
        submitMs: 4,
        cacheImported: false,
      });
      const submitted = vi.fn();
      const prepareAfterSelection = vi.fn(async () => {});
      const progress = vi.fn();
      const bridge = new TauriBridge();
      bridge.setProjectProgressListener(progress);

      await bridge[method](submitted, prepareAfterSelection);

      expect(open.mock.invocationCallOrder[0]).toBeLessThan(submitted.mock.invocationCallOrder[0]);
      expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(
        prepareAfterSelection.mock.invocationCallOrder[0],
      );
      expect(prepareAfterSelection.mock.invocationCallOrder[0]).toBeLessThan(
        invoke.mock.invocationCallOrder[0],
      );
      if (method === "openProject") {
        expect(progress).toHaveBeenCalledWith({ stage: "scanning", completed: 0, total: 0 });
        expect(progress.mock.invocationCallOrder[0]).toBeLessThan(
          invoke.mock.invocationCallOrder[0],
        );
      } else expect(progress).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["directory", "openProject", "/game/eraTW"],
    ["file", "openProjectFile", "/game/eraTW.reraproj"],
  ] as const)(
    "does not read the selected %s when session preparation fails",
    async (_kind, method, path) => {
      open.mockResolvedValue(path);
      const bridge = new TauriBridge();

      await expect(
        bridge[method](undefined, async () => {
          throw new Error("session failed");
        }),
      ).rejects.toThrow("session failed");

      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("applies native window settings from applicable project configuration", async () => {
    const entry = (code: string, value: string) => ({
      code,
      japanese: "",
      english: code,
      value,
      kind: "integer" as const,
      allowed: [],
      fixed: false,
      applicability: 8,
      default_value: value,
      effective_value: value,
      preference_eligible: true,
      client_effective_value: value,
      application: "hot" as const,
    });

    await new TauriBridge().applyProjectConfiguration(
      [
        entry("WindowX", "1100"),
        entry("WindowY", "750"),
        { ...entry("WindowMaximixed", "YES"), kind: "boolean" },
      ],
      { width: 20, height: 90 },
    );

    expect(currentWindow.setResizable).not.toHaveBeenCalled();
    expect(currentWindow.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1120, height: 840 }),
    );
    expect(currentWindow.setPosition).not.toHaveBeenCalled();
    expect(currentWindow.unmaximize).not.toHaveBeenCalled();
    expect(currentWindow.maximize).toHaveBeenCalledOnce();
  });

  it("leaves maximized mode before restoring normal window bounds", async () => {
    const entry = (code: string, value: string) => ({
      code,
      japanese: "",
      english: code,
      value,
      kind: "integer" as const,
      allowed: [],
      fixed: false,
      applicability: 8,
      default_value: value,
      effective_value: value,
      preference_eligible: true,
      client_effective_value: value,
      application: "hot" as const,
    });

    currentWindow.isMaximized.mockResolvedValueOnce(true);
    await new TauriBridge().applyProjectConfiguration(
      [
        { ...entry("WindowMaximixed", "NO"), kind: "boolean" },
        entry("WindowX", "900"),
        entry("WindowY", "600"),
      ],
      { width: 0, height: 0 },
    );

    expect(currentWindow.unmaximize).toHaveBeenCalledOnce();
    expect(currentWindow.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(
      currentWindow.setSize.mock.invocationCallOrder[0],
    );
    expect(currentWindow.setPosition).not.toHaveBeenCalled();
    expect(currentWindow.maximize).not.toHaveBeenCalled();
  });

  it("does not send an unnecessary unmaximize command for an already normal window", async () => {
    const entry = (code: string, value: string) => ({
      code,
      japanese: "",
      english: code,
      value,
      kind: "integer" as const,
      allowed: [],
      fixed: false,
      applicability: 8,
      default_value: value,
      effective_value: value,
      preference_eligible: true,
      client_effective_value: value,
      application: "hot" as const,
    });

    await new TauriBridge().applyProjectConfiguration(
      [
        { ...entry("WindowMaximixed", "NO"), kind: "boolean" },
        entry("WindowX", "900"),
        entry("WindowY", "600"),
      ],
      { width: 0, height: 0 },
    );

    expect(currentWindow.isMaximized).toHaveBeenCalledOnce();
    expect(currentWindow.unmaximize).not.toHaveBeenCalled();
    expect(currentWindow.setSize).toHaveBeenCalledOnce();
  });

  it("does not disturb native window state for unrelated hot settings", async () => {
    await new TauriBridge().applyProjectConfiguration(
      [
        {
          code: "WindowX",
          japanese: "",
          english: "Window width",
          value: "900",
          default_value: "760",
          effective_value: "900",
          preference_eligible: false,
          client_effective_value: "900",
          application: "hot",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
      ],
      { width: 0, height: 0 },
      ["FontSize"],
    );

    expect(currentWindow.unmaximize).not.toHaveBeenCalled();
    expect(currentWindow.setSize).not.toHaveBeenCalled();
    expect(currentWindow.maximize).not.toHaveBeenCalled();
  });
});

function diagnosisInput() {
  return {
    projectName: "eraFL",
    snapshot: Uint8Array.of(1),
    inputReplay: Uint8Array.of(2),
    logs: "log",
    projectFile: Uint8Array.of(3),
    exportedAt: new Date(2026, 7, 13, 12, 0, 0),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("Tauri lossless integer transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores unsafe protocol integers from pump responses", async () => {
    const response = {
      state: "output_ready",
      vmInstructions: 0,
      runtimeTransitions: 1,
      events: [
        {
          channel: "debug",
          sequence: 1,
          messageId: 2,
          message: {
            type: "grant",
            value: {
              token: {
                grant_id: { high: { $rustyeraInteger: "4919414282687566401" }, low: 1 },
              },
            },
          },
        },
      ],
    };
    invoke.mockResolvedValue(new TextEncoder().encode(JSON.stringify(response)).buffer);

    const batch = await new TauriBridge().pump();

    expect((batch.events[0].message.value as any).token.grant_id.high).toBe(
      4_919_414_282_687_566_401n,
    );
  });

  it("tags bigint fields before sending debug requests", async () => {
    invoke.mockResolvedValue({ $rustyeraInteger: "9007199254740993" });
    const bridge = new TauriBridge();

    const messageId = await bridge.submitDebug(
      {
        type: "request",
        value: {
          grant: { grant_id: { high: 4_919_414_282_687_566_401n, low: 1 } },
          command: { type: "pause" },
        },
      },
      9_007_199_254_740_993n,
    );

    expect(messageId).toBe(9_007_199_254_740_993n);
    expect(invoke).toHaveBeenCalledWith("submit_debug", {
      message: {
        type: "request",
        value: {
          grant: {
            grant_id: { high: { $rustyeraInteger: "4919414282687566401" }, low: 1 },
          },
          command: { type: "pause" },
        },
      },
      correlationId: { $rustyeraInteger: "9007199254740993" },
    });
  });

  it("keeps binary protocol payloads as typed arrays", async () => {
    invoke.mockResolvedValue(1);
    const bytes = Uint8Array.of(1, 2, 3);

    await new TauriBridge().submitRuntime({
      type: "service_response",
      value: { payload: bytes },
    });

    expect(invoke).toHaveBeenCalledWith("submit_runtime", {
      message: { type: "service_response", value: { payload: bytes } },
      correlationId: undefined,
    });
  });

  it("serializes delayed native runtime submissions in frontend observation order", async () => {
    let releaseFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      releaseFirst = resolve;
    });
    let runtimeCalls = 0;
    invoke.mockImplementation((command) => {
      if (command !== "submit_runtime") return Promise.resolve(undefined);
      runtimeCalls += 1;
      return runtimeCalls === 1 ? first : Promise.resolve(runtimeCalls);
    });
    const bridge = new TauriBridge();
    const submissions = [
      bridge.submitRuntime({
        type: "device_state_changed",
        value: { event_sequence: 1, device: "keyboard", code: 65, pressed: true },
      }),
      bridge.submitRuntime({
        type: "input",
        value: { intent: { type: "any_key", value: "a" } },
      }),
      bridge.submitRuntime({
        type: "device_state_changed",
        value: { event_sequence: 2, device: "keyboard", code: 65, pressed: false },
      }),
      bridge.submitRuntime({
        type: "client_state_changed",
        value: { focused: false, visible: true },
      }),
      bridge.submitRuntime({
        type: "device_state_changed",
        value: { event_sequence: 3, device: "mouse", code: 2, pressed: true },
      }),
      bridge.submitRuntime({
        type: "device_state_changed",
        value: { event_sequence: 4, device: "mouse", code: 2, pressed: false },
      }),
    ];
    await Promise.resolve();

    expect(commandCalls("submit_runtime")).toHaveLength(1);
    releaseFirst(1);
    await Promise.all(submissions);

    expect(commandCalls("submit_runtime").map(([, args]) => (args as any).message.type)).toEqual([
      "device_state_changed",
      "input",
      "device_state_changed",
      "client_state_changed",
      "device_state_changed",
      "device_state_changed",
    ]);
  });

  it("submits and decodes a native pumped input in one IPC call", async () => {
    const fixture = {
      submittedMessageId: { $rustyeraInteger: "9007199254740993" },
      state: "idle",
      vmInstructions: { $rustyeraInteger: "9007199254740994" },
      runtimeTransitions: 3,
      events: [
        {
          channel: "runtime",
          sequence: { $rustyeraInteger: "9007199254740995" },
          messageId: { $rustyeraInteger: "9007199254740996" },
          correlationId: { $rustyeraInteger: "9007199254740997" },
          epoch: null,
          message: {
            type: "test_first",
            value: { nestedId: { $rustyeraInteger: "9007199254740998" } },
          },
        },
        {
          channel: "runtime",
          sequence: 2,
          messageId: 3,
          correlationId: null,
          epoch: null,
          message: { type: "test_second" },
        },
      ],
    };
    invoke.mockResolvedValue(new TextEncoder().encode(JSON.stringify(fixture)).buffer);
    const bridge = new TauriBridge();

    const batch = await bridge.submitRuntimeAndPump(
      { type: "input", value: { message_skip: true } },
      9_007_199_254_740_993n,
    );

    expect(batch).toEqual({
      submittedMessageId: 9_007_199_254_740_993n,
      state: "idle",
      vmInstructions: 9_007_199_254_740_994n,
      runtimeTransitions: 3,
      events: [
        {
          channel: "runtime",
          sequence: 9_007_199_254_740_995n,
          messageId: 9_007_199_254_740_996n,
          correlationId: 9_007_199_254_740_997n,
          epoch: null,
          message: { type: "test_first", value: { nestedId: 9_007_199_254_740_998n } },
        },
        {
          channel: "runtime",
          sequence: 2,
          messageId: 3,
          correlationId: null,
          epoch: null,
          message: { type: "test_second" },
        },
      ],
    });
    expect(invoke).toHaveBeenCalledWith("submit_runtime_and_pump", {
      message: { type: "input", value: { message_skip: true } },
      correlationId: { $rustyeraInteger: "9007199254740993" },
    });
  });
});
