/* global document, structuredClone, window */

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSnapshotProgress,
  captureCompleteTauriSnapshot,
  resolveTauriBinary,
  snapshotProgressSignature,
  startTauriSessionMonitor,
} from "../scripts/tauri-test-support.mjs";

afterEach(() => {
  document.body.replaceChildren();
  delete window.__RUSTYERA_TEST__;
});

describe("Tauri end-to-end test support", () => {
  it.each([
    ["win32", "era-web-tauri.exe"],
    ["linux", "era-web-tauri"],
    ["darwin", "era-web-tauri"],
  ])("resolves the native binary name on %s", (platform, executable) => {
    const target = path.resolve("/workspace/isolated-build/target");
    const debugBinary = resolveTauriBinary(target, false, platform);
    const releaseBinary = resolveTauriBinary(target, true, platform);

    expect(debugBinary).toBe(path.join(target, "debug", executable));
    expect(releaseBinary).toBe(path.join(target, "release", executable));
    expect(path.basename(debugBinary)).toBe(executable);
    expect(path.basename(path.dirname(debugBinary))).toBe("debug");
    expect(path.basename(releaseBinary)).toBe(executable);
    expect(path.basename(path.dirname(releaseBinary))).toBe("release");
  });

  it("rejects missing or relative Cargo metadata instead of selecting an old default binary", () => {
    for (const directory of [undefined, "", "../target"])
      expect(() => resolveTauriBinary(directory, false)).toThrow("absolute target_directory");
  });

  it("captures every element with attributes, text, value, visibility, and runtime state", async () => {
    document.body.innerHTML =
      '<main data-stage="title"><input value="0"><progress value="2" max="3"></progress><span>era萝乐娜</span></main>';
    for (const element of document.querySelectorAll("*")) {
      element.getBoundingClientRect = () => ({ width: 100, height: 20 });
    }
    window.__RUSTYERA_TEST__ = { snapshot: () => ({ bridgeKind: "tauri", phase: "ready" }) };
    const browser = { execute: vi.fn(async (callback) => callback()) };

    const snapshot = await captureCompleteTauriSnapshot(browser);

    expect(snapshot.runtime).toEqual({ bridgeKind: "tauri", phase: "ready" });
    expect(snapshot.document).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "main",
          attributes: { "data-stage": "title" },
          text: "era萝乐娜",
          value: null,
          visible: true,
        }),
        expect.objectContaining({ tag: "input", value: "0", visible: true }),
        expect.objectContaining({ tag: "progress", value: 2, visible: true }),
      ]),
    );
  });

  it("rejects a complete snapshot command that exceeds its hard deadline", async () => {
    const browser = { execute: vi.fn(() => new Promise(() => {})) };

    await expect(captureCompleteTauriSnapshot(browser, 1)).rejects.toThrow(
      "complete snapshot capture exceeded 1 ms",
    );
  });

  it("rejects the second consecutive identical complete snapshot", () => {
    const snapshot = { document: [{ tag: "main" }], runtime: { phase: "waiting_input" } };

    expect(() => assertSnapshotProgress(snapshot, structuredClone(snapshot))).toThrow(
      /two consecutive complete snapshots were identical/,
    );
    expect(() =>
      assertSnapshotProgress(snapshot, { ...snapshot, runtime: { phase: "running" } }),
    ).not.toThrow();
  });

  it("ignores log timestamps but preserves observable runtime changes", () => {
    const first = {
      document: [],
      runtime: { phase: "running", logs: [{ timestamp: "2026-08-02T00:00:00Z", message: "tick" }] },
    };
    const second = {
      document: [],
      runtime: { phase: "running", logs: [{ timestamp: "2026-08-02T00:00:05Z", message: "tick" }] },
    };

    expect(snapshotProgressSignature(first)).toBe(snapshotProgressSignature(second));
    expect(() => assertSnapshotProgress(first, second)).toThrow(/identical/);
    expect(snapshotProgressSignature(first)).not.toBe(
      snapshotProgressSignature({
        ...second,
        runtime: { ...second.runtime, phase: "waiting_input" },
      }),
    );
  });

  it.each([
    [{ fault: { message: "boom" } }, /runtime faulted/],
    [
      { fault: null, logs: [{ message: "command rejected [VersionMismatch]: stale" }] },
      /rejected the configured state/,
    ],
    [
      { fault: null, logs: [{ message: "command rejected [ProtocolMismatch]: stale" }] },
      /rejected the configured state/,
    ],
  ])("fails the monitor for terminal runtime state %#", async (runtime, expected) => {
    const browser = { execute: vi.fn(async () => ({ document: [], runtime })) };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });

    await expect(monitor.failure).rejects.toThrow(expected);
    await expect(monitor.stop()).rejects.toThrow(expected);
  });

  it("fails exactly when the shared deadline is reached", async () => {
    const browser = { execute: vi.fn() };
    const monitor = startTauriSessionMonitor(browser, {
      deadline: Date.now() - 1,
      interval: 1,
      output: vi.fn(),
    });

    await expect(monitor.failure).rejects.toThrow(/60-minute wall-clock limit/);
    await expect(monitor.stop()).rejects.toThrow(/60-minute wall-clock limit/);
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("propagates an in-flight capture failure when stop races with the monitor", async () => {
    let finishCapture;
    const browser = {
      execute: vi.fn(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      ),
    };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });
    void monitor.failure.catch(() => undefined);
    const stopping = monitor.stop();
    finishCapture({ document: [], runtime: { fault: { message: "late fault" } } });

    await expect(stopping).rejects.toThrow(/runtime faulted/);
  });

  it("fails after two consecutive identical full snapshots", async () => {
    const snapshot = { document: [{ tag: "main" }], runtime: { phase: "running", logs: [] } };
    const browser = { execute: vi.fn(async () => structuredClone(snapshot)) };
    const monitor = startTauriSessionMonitor(browser, { interval: 1, output: vi.fn() });

    await expect(monitor.failure).rejects.toThrow(/two consecutive complete snapshots/);
    await expect(monitor.stop()).rejects.toThrow(/two consecutive complete snapshots/);
    expect(browser.execute).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly while waiting for the next snapshot", async () => {
    const snapshot = { document: [], runtime: { phase: "running", logs: [] } };
    const browser = { execute: vi.fn(async () => structuredClone(snapshot)) };
    const monitor = startTauriSessionMonitor(browser, { interval: 60_000, output: vi.fn() });
    await vi.waitFor(() => expect(browser.execute).toHaveBeenCalledOnce());

    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(browser.execute).toHaveBeenCalledOnce();
  });

  it("captures an overdue snapshot before stopping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let capture = 0;
    const output = vi.fn();
    const browser = {
      execute: vi.fn(async () => ({
        document: [{ tag: "main", text: String(++capture) }],
        runtime: { phase: String(capture) },
      })),
    };
    const monitor = startTauriSessionMonitor(browser, {
      interval: 5_000,
      output,
    });
    await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());

    vi.setSystemTime(5_001);
    await monitor.stop();

    expect(browser.execute).toHaveBeenCalledTimes(2);
  });
});
