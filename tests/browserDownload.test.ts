import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_FILE_SAVE_EVENT,
  type BrowserFileSaveRequest,
  downloadBrowserBlob,
} from "@/platform/browserDownload";

const secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

describe("browser blob downloads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (secureContextDescriptor)
      Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
    else Reflect.deleteProperty(window, "isSecureContext");
    vi.useRealTimers();
  });

  it("uses an object URL outside Firefox for iOS", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download-id");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
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

  it("retains the URL and backing file beyond timers until explicit download confirmation", () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backed-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const release = vi.fn();
    let request: BrowserFileSaveRequest | undefined;
    window.addEventListener(
      BROWSER_FILE_SAVE_EVENT,
      (event) => {
        request = (event as CustomEvent<BrowserFileSaveRequest>).detail;
      },
      { once: true },
    );

    downloadBrowserBlob("game.reraproj", new Blob(), release);

    expect(request?.mode).toBe("download");
    expect(request?.file.name).toBe("game.reraproj");
    expect(document.querySelector('a[download="game.reraproj"]')).toBeNull();
    vi.runAllTimers();
    expect(release).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    request?.release?.();
    request?.release?.();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:backed-download");
  });

  it("cleans up immediately and preserves a synchronous click failure", () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed-download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("download failed");
    });
    const release = vi.fn();

    expect(() => downloadBrowserBlob("runtime.snapshot", new Blob(), release)).toThrow(
      "download failed",
    );
    expect(document.querySelector('a[download="runtime.snapshot"]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-download");
    expect(release).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a backing resource until the queued iOS Firefox file is released", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone) FxiOS/151.0 Mobile/15E148 Safari/605.1.15",
      canShare: vi.fn(() => true),
      share: vi.fn(),
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const release = vi.fn();
    let request: BrowserFileSaveRequest | undefined;
    const receive = (event: Event) => {
      request = (event as CustomEvent<BrowserFileSaveRequest>).detail;
    };
    window.addEventListener(BROWSER_FILE_SAVE_EVENT, receive, { once: true });

    downloadBrowserBlob("game.reraproj", new Blob(), release);

    expect(release).not.toHaveBeenCalled();
    request?.release?.();
    request?.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("offers each exported file type to iOS Firefox with intact metadata and contents", async () => {
    const canShare = vi.fn(() => true);
    const share = vi.fn();
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone) FxiOS/151.0 Mobile/15E148 Safari/605.1.15",
      canShare,
      share,
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const received: File[] = [];
    const receive = (event: Event) =>
      received.push((event as CustomEvent<BrowserFileSaveRequest>).detail.file);
    window.addEventListener(BROWSER_FILE_SAVE_EVENT, receive);
    const cases = [
      ["runtime.snapshot", "", Uint8Array.of(1, 2, 3)],
      ["game.reraproj", "application/octet-stream", Uint8Array.of(4, 5)],
      ["diagnosis.tar.zst", "", Uint8Array.of(6)],
      ["rustyera.log", "text/plain;charset=utf-8", Uint8Array.of(7, 8)],
    ] as const;

    for (const [name, type, bytes] of cases) downloadBrowserBlob(name, new Blob([bytes], { type }));

    expect(canShare).toHaveBeenCalledTimes(cases.length);
    expect(received.map((file) => file.name)).toEqual(cases.map(([name]) => name));
    for (const [index, file] of received.entries()) {
      expect(file.type).toBe(cases[index]![1] || "application/octet-stream");
      expect(file.size).toBe(cases[index]![2].byteLength);
      expect(await readFile(file)).toEqual(cases[index]![2]);
    }
    window.removeEventListener(BROWSER_FILE_SAVE_EVENT, receive);
    expect(share).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "throws"])("falls back when iOS Firefox file sharing %s", (behavior) => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone) FxiOS/151.0 Mobile/15E148 Safari/605.1.15",
      canShare: vi.fn(() => {
        if (behavior === "throws") throw new TypeError("share probe failed");
        return false;
      }),
      share: vi.fn(),
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fallback");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBrowserBlob("runtime.snapshot", new Blob());
    expect(click).toHaveBeenCalledOnce();
  });

  it.each([
    ["iOS Safari", "Mozilla/5.0 (iPhone) Version/26.0 Mobile/15E148 Safari/604.1"],
    ["desktop Firefox", "Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/154.0"],
    ["Tauri WebKit", "Mozilla/5.0 (Macintosh) AppleWebKit/620.1 Safari/620.1"],
  ])("keeps %s on the object URL path", (_browser, userAgent) => {
    const canShare = vi.fn(() => true);
    vi.stubGlobal("navigator", { userAgent, canShare, share: vi.fn() });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:standard-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadBrowserBlob("runtime.snapshot", new Blob());

    expect(click).toHaveBeenCalledOnce();
    expect(canShare).not.toHaveBeenCalled();
  });
});
