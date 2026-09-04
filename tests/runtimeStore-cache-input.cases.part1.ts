import { bridge } from "./runtimeStoreTestSupport";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Preferences } from "@/core/types";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  defaultPreferences,
  deferred,
  emptyBatch,
  flushMicrotasks,
  mockProjectSelection,
  storeWithInputWait,
  storeWithPendingCompiledCacheWrite,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store cache-input", () => {
  installRuntimeStoreTestHarness();
  afterEach(() => useRuntimeStore().teardown());

  it("initializes global listeners once and removes them during teardown", async () => {
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const store = useRuntimeStore();

    await Promise.all([store.initialize(), store.initialize()]);

    expect(documentAdd.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    expect(documentAdd.mock.calls.filter(([type]) => type === "mousedown")).toHaveLength(1);
    expect(windowAdd.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);

    store.teardown();

    expect(documentRemove.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    expect(documentRemove.mock.calls.filter(([type]) => type === "mousedown")).toHaveLength(1);
    expect(windowRemove.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
    expect(bridge.setProjectProgressListener).toHaveBeenLastCalledWith(undefined);
    expect(bridge.dispose).toHaveBeenCalledOnce();
    documentAdd.mockRestore();
    documentRemove.mockRestore();
    windowAdd.mockRestore();
    windowRemove.mockRestore();
  });

  it("leaves a background cache export running when the project-file picker is cancelled", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);
    bridge.beginProjectFileExport.mockResolvedValueOnce(false);

    await store.exportProjectFile();

    expect(bridge.cancelCompiledCacheExport).not.toHaveBeenCalled();
    const transfer = store.testTransferState().export as { name?: string } | undefined;
    expect(transfer?.name).toBe("compiled-project.reracache");
    expect(store.gameInteractionsBlocked).toBe(false);
    cacheWrite.resolve();
    await flushMicrotasks();
  });

  it("publishes input waits while the compiled cache is still being persisted", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    expect(
      store.logs.some((entry) => entry.message.includes("compiled project cache preparation")),
    ).toBe(false);
    expect(store.logNotifications).toEqual([]);
    expect(bridge.writeCompiledCacheChunk).toHaveBeenCalledOnce();
    expect(store.status).toBe(
      "正在后台生成项目缓存，可继续游戏，但游戏运行和响应速度可能暂时受到影响…",
    );
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
    expect(
      bridge.submitRuntime.mock.calls
        .map(
          ([message]: unknown[]) =>
            message as { type?: string; value?: { maximum_bytes?: number } },
        )
        .filter((message) => message.type === "state_export_chunk_request")
        .map((message) => message.value?.maximum_bytes),
    ).toEqual([1024 * 1024, 1024 * 1024]);
  });

  it("restores the stable status after compiled-cache success feedback", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_export_chunk", {
          transfer_id: 7,
          offset: 3,
          data: [4, 5, 6],
          complete: true,
        }),
      ],
    });

    cacheWrite.resolve();
    await flushMicrotasks();
    await advanceUntil(() => store.testTransferState().export == null);

    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("项目缓存已保存。");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.status).toBe("游戏运行中");
  });

  it("clears a compiled-cache status when the initial request fails", async () => {
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [] }),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      ],
    });
    const store = useRuntimeStore();
    await store.openProject();
    await vi.advanceTimersByTimeAsync(16);
    bridge.submitRuntime.mockRejectedValueOnce(new Error("cache request failed"));

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("游戏运行中");
    expect(store.logs.at(-1)?.message).toContain("项目缓存生成失败");
  });

  it("does not build a speculative compiled cache on a memory-constrained host", async () => {
    bridge.automaticCompiledCacheExport = false;
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", { success: true, diagnostics: [] }),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
      ],
    });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
      ),
    ).toBe(false);
    expect(store.testTransferState().export).toBeNull();
    expect(bridge.writeCompiledCacheChunk).not.toHaveBeenCalled();
  });

  it("clears a compiled-cache status when cooperative preparation fails", async () => {
    mockProjectSelection({
      submittedAtMs: 0,
      quickScanMs: 1,
      cacheReadMs: 0,
      sourceReadMs: 1,
      submitMs: 1,
      cacheImported: false,
    });
    let reportSent = false;
    let preparationRejected = false;
    let failureSent = false;
    bridge.pump.mockImplementation(async () => {
      if (!reportSent) {
        reportSent = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("project_load_report", { success: true, diagnostics: [] }),
            runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          ],
        };
      }
      const cacheRequested = bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
      );
      if (cacheRequested && !preparationRejected) {
        preparationRejected = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "command_rejected",
              { message: "compiled project cache preparation started" },
              1,
            ),
          ],
        };
      }
      if (preparationRejected && !failureSent) {
        failureSent = true;
        return {
          ...emptyBatch(),
          events: [
            runtimeEvent("diagnostic", {
              code: "runtime.compiled_cache_failed",
              level: "warning",
              message: "bytecode source differs from the project manifest",
            }),
          ],
        };
      }
      return emptyBatch();
    });
    const store = useRuntimeStore();

    await store.openProject();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(store.testTransferState().export).toBeNull();
    expect(store.status).toBe("游戏运行中");
    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(store.logs.at(-1)?.message).toContain("项目缓存生成失败");
    expect(
      store.logNotifications.filter((notification) =>
        notification.message.includes("runtime.compiled_cache_failed"),
      ),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        message:
          "[runtime.compiled_cache_failed] bytecode source differs from the project manifest",
      }),
    ]);
  });

  it("keeps settings status above an active compiled-cache export", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);
    const preferencesWrite = deferred<Preferences>();
    bridge.savePreferences.mockReturnValueOnce(preferencesWrite.promise);

    const saving = store.saveClientPreferences("global", defaultPreferences());
    expect(store.status).toBe("正在保存客户端偏好…");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.status).toMatch(/^正在保存客户端偏好… · 已等待 1 秒$/);
    expect(store.status).not.toContain("后台生成项目缓存");

    preferencesWrite.resolve(defaultPreferences());
    await saving;
    expect(store.status).toBe("全局偏好已应用");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.status).toContain("正在后台生成项目缓存");

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_export_chunk", {
          transfer_id: 7,
          offset: 3,
          data: [4, 5, 6],
          complete: true,
        }),
      ],
    });
    cacheWrite.resolve();
    await flushMicrotasks();
    await advanceUntil(() => store.testTransferState().export == null);
    expect(store.status).toBe("项目缓存已保存。");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.status).toBe("游戏运行中");
  });

  it("does not let a late cache completion cover active settings", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);
    const preferencesWrite = deferred<Preferences>();
    bridge.savePreferences.mockReturnValueOnce(preferencesWrite.promise);
    const saving = store.saveClientPreferences("global", defaultPreferences());
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_export_chunk", {
          transfer_id: 7,
          offset: 3,
          data: [4, 5, 6],
          complete: true,
        }),
      ],
    });

    cacheWrite.resolve();
    await flushMicrotasks();
    await advanceUntil(() => store.testTransferState().export == null);

    expect(store.status).toContain("正在保存客户端偏好");
    preferencesWrite.resolve(defaultPreferences());
    await saving;
    expect(store.status).toBe("全局偏好已应用");
  });

  it("does not let an earlier settings timer clear a later save", async () => {
    const store = useRuntimeStore();
    await store.saveClientPreferences("global", defaultPreferences());
    expect(store.status).toBe("全局偏好已应用");
    await vi.advanceTimersByTimeAsync(1_000);
    const secondWrite = deferred<Preferences>();
    bridge.savePreferences.mockReturnValueOnce(secondWrite.promise);

    const secondSave = store.saveClientPreferences("global", defaultPreferences());
    await vi.advanceTimersByTimeAsync(1_100);

    expect(store.status).toContain("正在保存客户端偏好");
    secondWrite.resolve(defaultPreferences());
    await secondSave;
  });

  it("invalidates settings feedback when the session restarts", async () => {
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.saveClientPreferences("global", defaultPreferences());
    expect(store.status).toBe("全局偏好已应用");

    await store.restart();
    const restartedStatus = store.status;
    expect(restartedStatus).not.toBe("全局偏好已应用");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.status).toBe(restartedStatus);
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

  it("submits only tokens that remain enabled in the current presentation", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    };
    const store = await storeWithInputWait(wait, [
      runtimeEvent("presentation_delta", {
        base_revision: 1,
        new_revision: 2,
        operations: [
          {
            type: "append_line",
            line: {
              line_id: 1,
              temporary: false,
              logical_line_start: true,
              line_end: true,
              alignment: "left",
              runs: [
                {
                  type: "button",
                  runs: [{ type: "text", text: "current", style: {} }],
                  token: { epoch: 2, id: 6 },
                  enabled: true,
                  generation: 1,
                },
                {
                  type: "button",
                  runs: [{ type: "text", text: "expired", style: {} }],
                  token: { epoch: 2, id: 7 },
                  enabled: false,
                  generation: 0,
                },
              ],
            },
          },
        ],
      }),
    ]);
    bridge.submitRuntime.mockClear();

    await store.activate({ epoch: 2, id: 7 });
    expect(bridge.submitRuntime).not.toHaveBeenCalled();

    await store.activate({ epoch: 2, id: 6 });
    expect(bridge.submitRuntime).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 17,
          intent: { type: "activate", value: { epoch: 2, id: 6 } },
        }),
      }),
      undefined,
    );
  });

  it("re-arms unchanged buttons when the runtime opens the next value wait", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    };
    const token = { epoch: 2, id: 6 };
    const store = await storeWithInputWait(wait, [
      runtimeEvent("presentation_delta", {
        base_revision: 1,
        new_revision: 2,
        operations: [
          {
            type: "append_line",
            line: {
              line_id: 1,
              temporary: false,
              logical_line_start: true,
              line_end: true,
              alignment: "left",
              runs: [
                {
                  type: "button",
                  runs: [{ type: "text", text: "unavailable action", style: {} }],
                  token,
                  enabled: true,
                  generation: 0,
                },
              ],
            },
          },
        ],
      }),
    ]);
    bridge.submitRuntime.mockClear();

    await store.activate(token);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
    });
    await vi.advanceTimersByTimeAsync(32);

    const nextWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 7 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "opened", value: nextWait })],
    });
    await vi.advanceTimersByTimeAsync(32);
    await store.activate(token);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 18]);
  });

  it("submits and immediately retires an enabled HTML-island interaction", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    };
    const interaction = { epoch: 2, id: 8, enabled: true, generation: 1 };
    const store = await storeWithInputWait(wait, [
      runtimeEvent("presentation_delta", {
        base_revision: 1,
        new_revision: 2,
        operations: [
          {
            type: "set_html_island",
            html_island: [
              {
                nodes: [
                  {
                    type: "element",
                    interaction,
                    semantic: { type: "button", title: "island action" },
                    children: [{ type: "text", text: "island action" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ]);
    bridge.submitRuntime.mockClear();

    await store.activate({ epoch: 2, id: 8 });

    expect(bridge.submitRuntime).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 17,
          intent: { type: "activate", value: { epoch: 2, id: 8 } },
        }),
      }),
      undefined,
    );
    expect(interaction.enabled).toBe(true);
    expect(store.interactionEnabled(interaction)).toBe(false);
  });

  it("restores HTML-island interactions when input submission fails", async () => {
    const wait = {
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    };
    const interaction = { epoch: 2, id: 8, enabled: true, generation: 1 };
    const store = await storeWithInputWait(wait, [
      runtimeEvent("presentation_delta", {
        base_revision: 1,
        new_revision: 2,
        operations: [
          {
            type: "set_html_island",
            html_island: [
              {
                nodes: [
                  {
                    type: "element",
                    interaction,
                    semantic: { type: "button", title: "island action" },
                    children: [{ type: "text", text: "island action" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ]);
    bridge.submitRuntime.mockRejectedValueOnce(new Error("input transport failed"));

    await expect(store.activate({ epoch: 2, id: 8 })).rejects.toThrow("input transport failed");

    expect(interaction.enabled).toBe(true);
    expect(store.interactionEnabled(interaction)).toBe(true);
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

  it("submits AnyKey once from a viewport left click", async () => {
    const store = await storeWithInputWait({
      kind: "any_key",
      wait_id: 21,
      submission_token: { epoch: 2, id: 8 },
    });
    bridge.submitRuntime.mockClear();

    await store.continueFromViewport();

    expect(bridge.submitRuntime).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 21,
          intent: { type: "any_key", value: "\n" },
          message_skip: false,
        }),
      }),
      undefined,
    );
  });
});
