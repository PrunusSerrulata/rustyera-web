import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/platform/diagnosis", () => ({ streamDiagnosisArchiveInWorker: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  invoke.mockReset();
});

describe("Tauri process memory audit isolation", () => {
  it.each([undefined, "0", "1"])("samples only in audit builds (%s)", async (flag) => {
    vi.stubEnv("VITE_RUSTYERA_PERF_AUDIT", flag);
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const counters = { residentBytes: 1234, privateBytes: 5678, committedBytes: 9012 };
    invoke.mockImplementation(async (command) =>
      command === "memory_snapshot" ? counters : { messages: [], debugMessages: [] },
    );
    const { TauriBridge } = await import("@/platform/tauriBridge");
    const bridge = new TauriBridge();
    await bridge.createSession({
      clientName: "memory-audit-test",
      availableFonts: [],
      preferredLocales: [],
      audioAvailable: false,
      debugScopeMask: 0,
      maximumEnvelopeBytes: 1024,
      configurationProfile: "tauri",
    });
    await bridge.pump();
    await Promise.resolve();
    const sampleCalls = () =>
      invoke.mock.calls.filter(([command]) => command === "memory_snapshot");
    expect(sampleCalls()).toHaveLength(flag === "1" ? 1 : 0);
    vi.setSystemTime(15_001);
    await bridge.pump();
    await Promise.resolve();
    expect(sampleCalls()).toHaveLength(flag === "1" ? 2 : 0);
    expect(bridge.runtimeMemoryCounters().residentBytes).toBe(flag === "1" ? 1234 : null);
  });
});
