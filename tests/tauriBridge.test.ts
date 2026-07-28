import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save: vi.fn() }));

import { TauriBridge } from "@/platform/tauriBridge";

describe("Tauri project restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
