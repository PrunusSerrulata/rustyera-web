import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const currentWindow = vi.hoisted(() => ({
  close: vi.fn(),
  setResizable: vi.fn(),
  setSize: vi.fn(),
  setPosition: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => currentWindow }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save: vi.fn() }));

import { TauriBridge } from "@/platform/tauriBridge";

describe("Tauri project restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(vi.fn());
    currentWindow.setResizable.mockResolvedValue(undefined);
    currentWindow.setSize.mockResolvedValue(undefined);
    currentWindow.setPosition.mockResolvedValue(undefined);
    currentWindow.maximize.mockResolvedValue(undefined);
    currentWindow.unmaximize.mockResolvedValue(undefined);
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
    invoke.mockResolvedValue(metrics);
    const bridge = new TauriBridge();

    await bridge.openProject();
    await bridge.restartProject();

    expect(invoke).toHaveBeenNthCalledWith(1, "open_project", { path: "/game/eraTW" });
    expect(invoke).toHaveBeenNthCalledWith(2, "open_project", { path: "/game/eraTW" });
  });

  it("rejects restart before a project has been selected", async () => {
    await expect(new TauriBridge().restartProject()).rejects.toThrow("没有打开的项目");
  });

  it("keeps the previous project when opening a replacement fails", async () => {
    open.mockResolvedValueOnce("/game/old").mockResolvedValueOnce("/game/broken");
    invoke
      .mockResolvedValueOnce({ cacheImported: true })
      .mockRejectedValueOnce(new Error("compile failed"))
      .mockResolvedValueOnce({ cacheImported: true });
    const bridge = new TauriBridge();

    await bridge.openProject();
    await expect(bridge.openProject()).rejects.toThrow("compile failed");
    await bridge.restartProject();

    expect(bridge.projectName()).toBe("old");
    expect(invoke).toHaveBeenLastCalledWith("open_project", { path: "/game/old" });
  });

  it("reopens a selected project file through the packaged-project command", async () => {
    open.mockResolvedValue("/game/eraTW.reraproj");
    invoke.mockResolvedValue({ cacheImported: true });
    const bridge = new TauriBridge();

    await bridge.openProjectFile();
    await bridge.restartProject();

    expect(invoke).toHaveBeenNthCalledWith(1, "open_project_file", {
      path: "/game/eraTW.reraproj",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "open_project_file", {
      path: "/game/eraTW.reraproj",
    });
    expect(bridge.projectName()).toBe("eraTW");
    expect(bridge.projectConfigurationWritable()).toBe(false);
  });

  it("writes configuration only for an opened source directory", async () => {
    open.mockResolvedValue("/game/eraTW");
    invoke.mockResolvedValue({ cacheImported: false });
    const bridge = new TauriBridge();

    expect(bridge.projectConfigurationWritable()).toBe(false);
    await bridge.openProject();
    expect(bridge.projectConfigurationWritable()).toBe(true);
    await bridge.writeProjectConfiguration(Uint8Array.of(1, 2), "FontSize:18\n");

    expect(invoke).toHaveBeenLastCalledWith("write_project_configuration", {
      expectedDigest: [1, 2],
      contents: "FontSize:18\n",
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

  it("starts progress after the directory picker returns and before native scanning", async () => {
    open.mockResolvedValue("/game/eraTW");
    invoke.mockResolvedValue({
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 3,
      submitMs: 4,
      cacheImported: false,
    });
    const progress = vi.fn();
    const bridge = new TauriBridge();
    bridge.setProjectProgressListener(progress);

    await bridge.openProject();

    expect(progress).toHaveBeenCalledWith({ stage: "scanning", completed: 0, total: 0 });
    expect(progress.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
  });

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

    expect(currentWindow.unmaximize).toHaveBeenCalledOnce();
    expect(currentWindow.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(
      currentWindow.setSize.mock.invocationCallOrder[0],
    );
    expect(currentWindow.setPosition).not.toHaveBeenCalled();
    expect(currentWindow.maximize).not.toHaveBeenCalled();
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

describe("Tauri lossless integer transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores unsafe protocol integers from pump responses", async () => {
    invoke.mockResolvedValue({
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
    });

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
});
