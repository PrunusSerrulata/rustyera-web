import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBrowserBlob } from "@/platform/browserDownload";

describe("browser blob downloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the named anchor connected while Firefox for iOS observes its click", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download-id");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      expect(this.hidden).toBe(true);
      expect(this.download).toBe("runtime.snapshot");
      expect(this.href).toBe("blob:download-id");
    });

    const blob = new Blob([Uint8Array.of(1, 2, 3)]);
    downloadBrowserBlob("runtime.snapshot", blob);

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download="runtime.snapshot"]')).not.toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(document.querySelector('a[download="runtime.snapshot"]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download-id");
  });

  it("cleans up immediately and preserves a synchronous click failure", () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed-download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("download failed");
    });

    expect(() => downloadBrowserBlob("runtime.snapshot", new Blob())).toThrow("download failed");
    expect(document.querySelector('a[download="runtime.snapshot"]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-download");
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});
