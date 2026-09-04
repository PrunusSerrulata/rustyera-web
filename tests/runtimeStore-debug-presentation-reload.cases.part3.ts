import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  deferred,
  emptyBatch,
  flushMicrotasks,
  plainLine,
  runningBrowserStore,
  storeWithInputWait,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store debug-presentation-reload", () => {
  installRuntimeStoreTestHarness();

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

  it("keeps the previous frame visible across a timed animation CLEARLINE batch", async () => {
    const line = (lineId: number, text: string) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [{ type: "text", text, style: {} }],
    });
    const timedWait = (waitId: number) => ({
      kind: "integer_value",
      wait_id: waitId,
      submission_token: { epoch: 2, id: waitId },
      deadline_ns: waitId * 1_000_000,
    });
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "animation",
            history: { logical_lines: [line(1, "frame 1")] },
            input_wait: timedWait(10),
            redraw: { enabled: true },
          }),
          runtimeEvent("wait_changed", { type: "opened", value: timedWait(10) }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        state: "output_ready",
        events: [
          runtimeEvent("wait_changed", { type: "closed", value: null }),
          runtimeEvent("presentation_delta", {
            base_revision: 1,
            new_revision: 2,
            operations: [{ type: "delete_lines", count: 1 }],
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
              { type: "set_input_wait", input_wait: timedWait(11) },
            ],
          }),
          runtimeEvent("wait_changed", { type: "opened", value: timedWait(11) }),
        ],
      });
    const store = useRuntimeStore();

    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 1");

    await vi.advanceTimersByTimeAsync(16);
    expect(store.presentation.revision).toBe(1);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 1");

    await vi.advanceTimersByTimeAsync(16);
    expect(store.presentation.revision).toBe(3);
    expect(plainLine(store.presentation.lines[0])).toBe("frame 2");
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

  it("lists and submits a scoped script-folder hot reload", async () => {
    const store = await runningBrowserStore();

    await store.openProjectReloadDialog("folder");

    expect(bridge.projectReloadTargets).toHaveBeenCalledOnce();
    expect(store.projectReloadDialogMode).toBe("folder");
    expect(store.projectReloadTargetOptions).toEqual(["ERB/events"]);
    expect(store.canInteract).toBe(false);

    await store.confirmProjectReload("ERB/events");

    expect(store.projectReloadDialogMode).toBeNull();
    expect(bridge.reloadProject).toHaveBeenCalledWith({
      type: "folder",
      path: "ERB/events",
    });
  });

  it("handles a correlated hot-reload report without submitting another game start", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 12,
      submission_token: { epoch: 2, id: 12 },
    };
    const store = await storeWithInputWait(wait);
    const resourceGenerationBefore = store.projectResourceGeneration;
    const startsBefore = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "start",
    ).length;
    bridge.reloadProject.mockResolvedValueOnce({ fonts: [], errors: [], messageId: 77 });
    bridge.finalizeProjectReload.mockImplementationOnce(async () => {
      expect(store.projectResourceGeneration).toBe(resourceGenerationBefore);
      return { fonts: [], errors: [] };
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [] }, 77),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 3 }),
      ],
    });

    await store.reloadProject({ type: "folder", path: "ERB/events" });
    await advanceUntil(() => store.runtimeEpoch === 3);

    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("游戏运行中");
    expect(store.presentation.inputWait).toEqual(wait);
    expect(store.projectResourceGeneration).toBe(resourceGenerationBefore + 1);
    expect(bridge.finalizeProjectReload).toHaveBeenCalledWith(true);
    expect(store.canInteract).toBe(true);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "start",
      ),
    ).toHaveLength(startsBefore);
    expect(store.logs.some((entry) => entry.message.includes("Runtime 拒绝"))).toBe(false);
  });

  it("settles a correlated hot reload rejected by Runtime", async () => {
    const store = await runningBrowserStore();
    bridge.reloadProject.mockResolvedValueOnce({ fonts: [], errors: [], messageId: 78 });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "reload rejected" }, 78)],
    });

    await store.reloadProject({ type: "script", path: "ERB/events/day.erb" });
    await advanceUntil(() => store.status.includes("reload rejected"));

    expect(store.projectLoading).toBe(false);
    expect(store.logs.filter((entry) => entry.message.includes("reload rejected"))).toHaveLength(1);
    expect(bridge.finalizeProjectReload).toHaveBeenCalledWith(false);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "start",
      ),
    ).toHaveLength(0);
  });

  it("settles an unsuccessful correlated hot-reload report", async () => {
    const store = await runningBrowserStore();
    const resourceGenerationBefore = store.projectResourceGeneration;
    bridge.reloadProject.mockResolvedValueOnce({ fonts: [], errors: [], messageId: 79 });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "project_load_report",
          {
            success: false,
            diagnostics: [
              {
                level: "warning",
                code: "compile.warning",
                message: "warning detail",
                notification: "default",
              },
              {
                level: "error",
                code: "compile.failed",
                message: "bad script",
                notification: "default",
              },
            ],
          },
          79,
        ),
      ],
    });

    await store.reloadProject();
    await advanceUntil(() => store.status === "重新加载项目失败，请查看日志");

    expect(store.projectLoading).toBe(false);
    expect(store.projectResourceGeneration).toBe(resourceGenerationBefore);
    expect(bridge.finalizeProjectReload).toHaveBeenCalledWith(false);
    expect(store.logs.some((entry) => entry.message.includes("bad script"))).toBe(true);
    expect(
      store.logNotifications.some((notification) =>
        notification.message.includes("warning detail"),
      ),
    ).toBe(false);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "start",
      ),
    ).toHaveLength(0);
  });

  it("ignores a stale reload-target request after the game session restarts", async () => {
    const store = await runningBrowserStore();
    const targets = deferred<{ folders: string[]; scripts: string[] }>();
    bridge.projectReloadTargets.mockReturnValueOnce(targets.promise);

    const opening = store.openProjectReloadDialog("folder");
    await flushMicrotasks();
    expect(store.projectReloadDialogBusy).toBe(true);

    await store.restart();
    targets.resolve({ folders: ["ERB/stale"], scripts: ["ERB/stale/main.erb"] });
    await opening;

    expect(store.projectReloadDialogMode).toBeNull();
    expect(store.projectReloadTargetOptions).toEqual([]);
    expect(store.projectReloadDialogBusy).toBe(false);
    expect(store.projectReloadDialogError).toBe("");
  });
});
