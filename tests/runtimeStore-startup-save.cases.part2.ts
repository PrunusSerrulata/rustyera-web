import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import type { ProjectOpenMetrics } from "@/core/types";
import {
  installRuntimeStoreTestHarness,
  deferred,
  emptyBatch,
  flushMicrotasks,
  mockProjectSelection,
  stubRunningAudioContext,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store startup-save", () => {
  installRuntimeStoreTestHarness();

  it("terminates startup telemetry when a bridge fails after submission", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        throw new Error("scan failed");
      },
    );
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toMatchObject({
      scenario: "cold",
      outcome: "failure",
      error: "Error: scan failed",
    });
  });

  it("does not wait for browser audio unlock before opening a project", async () => {
    const { resume } = stubRunningAudioContext(() => new Promise<void>(() => {}));
    mockProjectSelection({
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
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ audioAvailable: true }),
    );
    expect(bridge.openProject).toHaveBeenCalledOnce();
  });

  it("does not advertise audio when the media provider is unavailable", async () => {
    mockProjectSelection({
      submittedAtMs: performance.now(),
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ audioAvailable: false }),
    );
  });

  it("does not create a startup attempt when project selection is cancelled", async () => {
    stubRunningAudioContext();
    mockProjectSelection(undefined);
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.startupTelemetry).toBeUndefined();
  });

  it.each([
    ["directory", "openProject", "openProject"],
    ["file", "openProjectFile", "openProjectFile"],
  ] as const)(
    "opens the %s picker before session preparation",
    async (selection, storeMethod, bridgeMethod) => {
      stubRunningAudioContext();
      let confirmSelection!: () => void;
      const selected = new Promise<void>((resolve) => {
        confirmSelection = resolve;
      });
      bridge[bridgeMethod].mockImplementation(async (onSubmitted, prepareAfterSelection) => {
        await selected;
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 0,
          sourceReadMs: 1,
          submitMs: 1,
          cacheImported: false,
        };
      });
      const store = useRuntimeStore();

      const opening = store[storeMethod]();

      expect(bridge[bridgeMethod]).toHaveBeenCalledOnce();
      expect(bridge.createSession).not.toHaveBeenCalled();

      confirmSelection();
      await opening;

      expect(bridge.createSession).toHaveBeenCalledOnce();
      expect(store.projectSource).toBe(selection);
    },
  );

  it("replaces an in-flight prewarmed session when audio becomes ready on selection", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    const session = deferred<ReturnType<typeof emptyBatch>>();
    bridge.createSession.mockReturnValue(session.promise);
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    const opening = store.openProjectFile();
    await flushMicrotasks();

    expect(bridge.createSession).toHaveBeenCalledOnce();
    expect(store.projectLoading).toBe(true);
    expect(store.projectLoadProgressLabel).toBe("正在初始化 Runtime…");
    session.resolve(emptyBatch());
    await opening;
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(bridge.createSession.mock.calls[0]![0].audioAvailable).toBe(false);
    expect(bridge.createSession.mock.calls[1]![0].audioAvailable).toBe(true);
    expect(bridge.prepareSessionReplacement).toHaveBeenCalledOnce();
  });

  it("retries session creation when constrained-browser prewarming fails", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    bridge.createSession.mockRejectedValueOnce(new Error("prewarm failed"));
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    await flushMicrotasks();
    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
  });

  it("retries session creation when the prewarmed initial batch fails", async () => {
    stubRunningAudioContext();
    bridge.kind = "browser";
    bridge.prewarmRuntimeOnInitialize = true;
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("presentation_delta", {
          base_revision: 999,
          new_revision: 1000,
          operations: [],
        }),
      ],
    });
    bridge.submitRuntime.mockRejectedValueOnce(new Error("initial resynchronization failed"));
    mockProjectSelection(
      {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();

    await store.initialize();
    await flushMicrotasks();
    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
  });

  it("keeps the Runtime pump stopped until the selected project is installed by its host", async () => {
    stubRunningAudioContext();
    const selected = deferred<ProjectOpenMetrics | undefined>();
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return selected.promise;
    });
    const store = useRuntimeStore();

    const opening = store.openProjectFile();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(bridge.pump).not.toHaveBeenCalled();
    selected.resolve({
      submittedAtMs: performance.now(),
      quickScanMs: 0,
      cacheReadMs: 0,
      sourceReadMs: 0,
      submitMs: 1,
      cacheImported: true,
      projectFonts: { fonts: [], errors: [] },
    });
    await opening;
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.pump).toHaveBeenCalledOnce();
  });

  it("publishes writable packaged-project preferences before Runtime loading finishes", async () => {
    stubRunningAudioContext();
    bridge.currentProjectPreferences.mockReturnValue({
      settings: { UseMouse: "NO" },
      imageScale: 1.5,
    });
    bridge.projectPreferencesWritable.mockReturnValue(true);
    bridge.saveProjectPreferences.mockImplementation(async (value) => value);
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
        projectFonts: { fonts: [], errors: [] },
      };
    });
    const store = useRuntimeStore();

    await store.openProjectFile();

    expect(store.projectLoading).toBe(true);
    expect(store.projectPreferencesWritable).toBe(true);
    expect(store.projectPreferences).toEqual({
      settings: { UseMouse: "NO" },
      imageScale: 1.5,
    });
    store.openPreferencesFromUser();
    await store.saveClientPreferences("project", {
      settings: { UseMouse: "YES" },
      imageScale: 1.25,
    });
    expect(bridge.saveProjectPreferences).toHaveBeenCalledWith({
      settings: { UseMouse: "YES" },
      imageScale: 1.25,
    });
    expect(store.preferencesOpen).toBe(false);
  });

  it("rebuilds the locked Runtime after host project installation fails", async () => {
    stubRunningAudioContext();
    let attempts = 0;
    bridge.openProjectFile.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      if (attempts++ === 0) throw new Error("host project install failed");
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 0,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      };
    });
    const store = useRuntimeStore();

    await store.openProjectFile();

    expect(store.status).toBe("Error: host project install failed");
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(bridge.pump).not.toHaveBeenCalled();
    expect(bridge.createSession.mock.invocationCallOrder[1]).toBeLessThan(
      bridge.pump.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await store.openProjectFile();

    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(store.projectSource).toBe("file");
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pump).toHaveBeenCalled();
  });

  it("keeps the current project when replacement selection is cancelled", async () => {
    stubRunningAudioContext();
    mockProjectSelection(undefined);
    const store = useRuntimeStore();
    store.projectOpen = true;
    store.projectSource = "file";

    await store.openProject();
    await store.confirmOpenProject();

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(store.projectOpen).toBe(true);
    expect(store.projectSource).toBe("file");
    expect(store.status).toBe("已取消打开项目");
    expect(store.canOpenProject).toBe(true);
  });

  it("does not overwrite the previous project telemetry when the picker fails", async () => {
    stubRunningAudioContext();
    const store = useRuntimeStore();
    store.projectSource = "file";
    const previousTelemetry = {
      scenario: "warm",
      selection: "directory",
      outcome: "loading",
    } as any;
    store.startupTelemetry = previousTelemetry;
    bridge.openProject.mockRejectedValue(new Error("picker failed"));

    await store.openProject();

    expect(store.startupTelemetry).toEqual(previousTelemetry);
    expect(store.projectSource).toBe("file");
    expect(store.status).toBe("Error: picker failed");
  });

  it("classifies a rejected cache followed by source submission as cold", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 2,
          sourceReadMs: 0,
          submitMs: 3,
          cacheImported: true,
        };
      },
    );
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

  it("does not pump a cache-hit load before host project installation finishes", async () => {
    stubRunningAudioContext();
    const hostMetrics = deferred<ProjectOpenMetrics>();
    bridge.openProject.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return hostMetrics.promise;
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [
            { code: "runtime.compiled_cache_hit", level: "info", message: "cache hit" },
          ],
        }),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      ],
    });
    const store = useRuntimeStore();

    const opening = store.openProject();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(bridge.pump).not.toHaveBeenCalled();
    expect(store.status).toBe("正在读取项目…");

    hostMetrics.resolve({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
      projectFonts: { fonts: [], errors: [] },
    });
    await opening;
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("游戏运行中");
    expect(store.startupTelemetry).toMatchObject({
      scenario: "warm",
      cacheHit: true,
      outcome: "success",
    });

    expect(store.projectOpen).toBe(true);
    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.status).toBe("游戏运行中");
    expect(store.startupTelemetry?.bridge).toEqual({
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
    });
  });

  it("fails the active attempt when Runtime rejects its Start command", async () => {
    stubRunningAudioContext();
    bridge.openProject.mockImplementation(
      async (
        onSubmitted?: (submittedAtMs: number) => void,
        prepareAfterSelection?: () => Promise<void>,
      ) => {
        onSubmitted?.(performance.now());
        await prepareAfterSelection?.();
        return {
          submittedAtMs: performance.now(),
          quickScanMs: 1,
          cacheReadMs: 0,
          sourceReadMs: 1,
          submitMs: 1,
          cacheImported: false,
        };
      },
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("project_load_report", { success: true, diagnostics: [] })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "start rejected" }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(48);

    expect(store.startupTelemetry).toMatchObject({
      outcome: "failure",
      error: "start rejected",
    });
    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("项目启动失败：start rejected");
  });

  it("settles project loading when Runtime faults during startup", async () => {
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 2,
      sourceReadMs: 0,
      submitMs: 3,
      cacheImported: true,
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "faulted", epoch: 2 })],
    });
    const store = useRuntimeStore();

    await store.openProject();
    expect(store.projectLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.projectLoading).toBe(false);
    expect(store.projectLoadProgressLabel).toBe("");
    expect(store.startupTelemetry).toMatchObject({
      outcome: "failure",
      error: "Runtime entered faulted during startup",
    });
  });

  it("keeps Firefox and Safari directory copying visible through the build handoff", async () => {
    bridge.kind = "browser";
    stubRunningAudioContext();
    let resolveOpenProject!: (metrics: {
      submittedAtMs: number;
      quickScanMs: number;
      cacheReadMs: number;
      sourceReadMs: number;
      submitMs: number;
      cacheImported: boolean;
    }) => void;
    bridge.openProject.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      return new Promise((resolve) => {
        resolveOpenProject = resolve;
      });
    });
    const store = useRuntimeStore();

    const opening = store.openProject();
    await vi.waitFor(() => expect(bridge.openProject).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(resolveOpenProject).toBeTypeOf("function"));
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
});
