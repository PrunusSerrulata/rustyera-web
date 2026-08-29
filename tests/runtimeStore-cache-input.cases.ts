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

function keyboardEvent(
  type: "keydown" | "keyup",
  keyCode: number,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, init);
  Object.defineProperty(event, "keyCode", { configurable: true, value: keyCode });
  return event;
}

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

  it.each<[string, string, { type: string; value?: string }]>([
    ["AnyKey", "any_key", { type: "any_key", value: "\n" }],
    ["EnterKey", "enter_key", { type: "enter" }],
  ])(
    "submits %s message skipping directly from a viewport right click",
    async (_, kind, intent) => {
      const store = await storeWithInputWait({
        kind,
        wait_id: 22,
        submission_token: { epoch: 2, id: 9 },
      });
      bridge.submitRuntime.mockClear();

      await store.skip();

      expect(bridge.submitRuntime).toHaveBeenCalledOnce();
      expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "input",
          value: expect.objectContaining({
            wait_id: 22,
            intent,
            message_skip: true,
          }),
        }),
        undefined,
      );
    },
  );

  it("uses the native submit-and-pump fast path for message skipping", async () => {
    const store = await storeWithInputWait({
      kind: "any_key",
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    const submitRuntimeAndPump = vi.fn(async () => ({
      ...emptyBatch(),
      submittedMessageId: 41,
    }));
    bridge.submitRuntimeAndPump = submitRuntimeAndPump;
    bridge.submitRuntime.mockClear();

    await store.skip();

    expect(submitRuntimeAndPump).toHaveBeenCalledOnce();
    expect(submitRuntimeAndPump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 22,
          intent: { type: "any_key", value: "\n" },
          message_skip: true,
        }),
      }),
      undefined,
    );
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
  });

  it("fails closed when native fast submission may already have accepted the input", async () => {
    const interaction = { epoch: 2, id: 8, enabled: true, generation: 1 };
    const store = await storeWithInputWait(
      {
        kind: "any_key",
        wait_id: 22,
        submission_token: { epoch: 2, id: 9 },
      },
      [
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
      ],
    );
    bridge.submitRuntimeAndPump = vi.fn(async () => {
      throw new Error("native response was lost");
    });

    await expect(store.skip()).rejects.toThrow("native response was lost");

    expect(store.interactionEnabled(interaction)).toBe(false);
    expect(store.fault).toMatchObject({ code: "frontend" });
    expect(store.canInteract).toBe(false);
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
  });

  it.each<[string, { kind: string; stop_message_skip?: boolean }]>([
    ["a stop-message-skip wait", { kind: "enter_key", stop_message_skip: true }],
    ["a non-message wait", { kind: "integer_value" }],
  ])("balances the compatibility mouse device event for %s", async (_, wait) => {
    const store = await storeWithInputWait({
      ...wait,
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    bridge.submitRuntime.mockClear();

    await store.skip();

    const devices = bridge.submitRuntime.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "device_state_changed");
    expect(devices).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          event_sequence: 1,
          device: "mouse",
          code: 2,
          pressed: true,
        }),
      }),
      expect.objectContaining({
        value: expect.objectContaining({
          event_sequence: 2,
          device: "mouse",
          code: 2,
          pressed: false,
        }),
      }),
    ]);
  });

  it("queues browser pumping without waiting for the ordered submission acknowledgement", async () => {
    const store = await storeWithInputWait({
      kind: "any_key",
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    await vi.advanceTimersByTimeAsync(32);
    bridge.kind = "browser";
    bridge.pump.mockClear();
    let acknowledge!: (messageId: number) => void;
    bridge.submitRuntime.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        acknowledge = resolve;
      }),
    );

    const skipping = store.skip();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.pump).toHaveBeenCalled();
    acknowledge(41);
    await skipping;
  });

  it("holds a right-click skip across a running frame and uses ordered fallback reentrantly", async () => {
    const store = await storeWithInputWait({
      kind: "any_key",
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "closed", value: null }),
        runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    const submitRuntimeAndPump = vi.fn(async () => ({
      ...emptyBatch(),
      submittedMessageId: 41,
    }));
    bridge.submitRuntimeAndPump = submitRuntimeAndPump;
    bridge.submitRuntime.mockClear();

    await store.skip();

    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]) => message.type === "device_state_changed",
      ),
    ).toHaveLength(2);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "opened",
          value: {
            kind: "any_key",
            wait_id: 23,
            submission_token: { epoch: 2, id: 10 },
            deadline_ns: 1_000_000,
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.submitRuntime).toHaveBeenCalledTimes(3);
    expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 23,
          intent: { type: "any_key", value: "\n" },
          message_skip: true,
        }),
      }),
      undefined,
    );
    expect(submitRuntimeAndPump).not.toHaveBeenCalled();
  });

  it("drops a held right-click skip at a non-skippable input boundary", async () => {
    const store = await storeWithInputWait({
      kind: "any_key",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "closed", value: null }),
        runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    bridge.submitRuntime.mockClear();

    await store.skip();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "opened",
          value: {
            kind: "integer_value",
            wait_id: 24,
            submission_token: { epoch: 2, id: 11 },
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]) => message.type === "device_state_changed",
      ),
    ).toHaveLength(2);
  });

  it("submits an ordered physical key observation before its ordinary AnyKey input", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "any_key",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    bridge.submitRuntime.mockClear();
    const deviceAccepted = deferred<number>();
    let nextMessageId = 2;
    bridge.submitRuntime.mockImplementation(async (message) =>
      message.type === "device_state_changed" ? deviceAccepted.promise : nextMessageId++,
    );

    document.dispatchEvent(keyboardEvent("keydown", 32, { key: " ", code: "Space" }));
    await flushMicrotasks();

    expect(bridge.submitRuntime.mock.calls.map(([message]) => message.type)).toEqual([
      "device_state_changed",
    ]);
    deviceAccepted.resolve(1);
    await advanceUntil(() => bridge.submitRuntime.mock.calls.length === 2);

    expect(bridge.submitRuntime.mock.calls.map(([message]) => message.type)).toEqual([
      "device_state_changed",
      "input",
    ]);
    expect(bridge.submitRuntime.mock.calls[0]?.[0]).toMatchObject({
      value: {
        event_sequence: 1,
        toggle: false,
        repeat: false,
        device: "keyboard",
        code: 32,
        pressed: true,
      },
    });
    expect(bridge.submitRuntime.mock.calls[1]?.[0]).toMatchObject({
      value: {
        wait_id: 23,
        intent: { type: "any_key", value: " " },
        message_skip: false,
      },
    });
  });

  it("resynchronizes a key held before readiness and then submits its release", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    document.dispatchEvent(keyboardEvent("keydown", 65, { key: "a", code: "KeyA" }));
    await flushMicrotasks();
    expect(bridge.submitRuntime).not.toHaveBeenCalled();

    const ready = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    expect(ready).toBe(store);
    await flushMicrotasks();
    expect(
      bridge.submitRuntime.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "device_state_changed"),
    ).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          event_sequence: 1,
          device: "keyboard",
          code: 65,
          pressed: true,
        }),
      }),
    ]);

    document.dispatchEvent(keyboardEvent("keyup", 65, { key: "a", code: "KeyA" }));
    await flushMicrotasks();
    expect(
      bridge.submitRuntime.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "device_state_changed")
        .at(-1),
    ).toMatchObject({ value: { event_sequence: 2, code: 65, pressed: false } });
  });

  it("resynchronizes a held mouse button across an epoch and releases it in the new order", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "integer_value",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    bridge.submitRuntime.mockClear();

    document.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 17, clientY: 23 }));
    await flushMicrotasks();
    expect(bridge.submitRuntime.mock.calls[0]?.[0]).toMatchObject({
      type: "device_state_changed",
      value: { event_sequence: 1, device: "mouse", code: 2, pressed: true, x: 17, y: 23 },
    });
    bridge.submitRuntime.mockClear();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 3 })],
    });
    await vi.advanceTimersByTimeAsync(32);
    await flushMicrotasks();
    expect(bridge.submitRuntime.mock.calls[0]?.[0]).toMatchObject({
      type: "device_state_changed",
      value: { event_sequence: 1, device: "mouse", code: 2, pressed: true, x: 17, y: 23 },
    });

    document.dispatchEvent(new MouseEvent("mouseup", { button: 2, clientX: 18, clientY: 24 }));
    await flushMicrotasks();
    expect(bridge.submitRuntime.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "device_state_changed",
      value: { event_sequence: 2, device: "mouse", code: 2, pressed: false, x: 18, y: 24 },
    });
  });

  it("waits for delayed blur releases before submitting the client focus boundary", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "integer_value",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    document.dispatchEvent(keyboardEvent("keydown", 66, { key: "b", code: "KeyB" }));
    await flushMicrotasks();
    bridge.submitRuntime.mockClear();
    const releaseAccepted = deferred<number>();
    bridge.submitRuntime.mockImplementation(async (message) =>
      message.type === "device_state_changed" ? releaseAccepted.promise : 3,
    );
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    window.dispatchEvent(new Event("blur"));
    await flushMicrotasks();
    expect(bridge.submitRuntime.mock.calls.map(([message]) => message.type)).toEqual([
      "device_state_changed",
    ]);

    releaseAccepted.resolve(2);
    await advanceUntil(() => bridge.submitRuntime.mock.calls.length === 2);
    expect(bridge.submitRuntime.mock.calls.map(([message]) => message.type)).toEqual([
      "device_state_changed",
      "client_state_changed",
    ]);
    focused.mockRestore();
  });

  it("reports repeat, mouse edges, and blur releases in FIFO order", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "integer_value",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    bridge.submitRuntime.mockClear();

    document.dispatchEvent(keyboardEvent("keydown", 65, { key: "a", code: "KeyA" }));
    document.dispatchEvent(keyboardEvent("keydown", 65, { key: "a", code: "KeyA", repeat: true }));
    document.dispatchEvent(keyboardEvent("keyup", 65, { key: "a", code: "KeyA" }));
    document.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 17, clientY: 23 }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 2, clientX: 18, clientY: 24 }));
    document.dispatchEvent(keyboardEvent("keydown", 66, { key: "b", code: "KeyB" }));
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    await flushMicrotasks();
    focused.mockRestore();
    document.dispatchEvent(keyboardEvent("keydown", 67, { key: "c", code: "KeyC" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advanceUntil(
      () =>
        bridge.submitRuntime.mock.calls.filter(
          ([message]) => message.type === "device_state_changed",
        ).length === 9 &&
        bridge.submitRuntime.mock.calls.at(-1)?.[0].type === "client_state_changed",
    );
    visibility.mockRestore();

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    const devices = messages.filter((message) => message.type === "device_state_changed");
    expect(devices.map((message) => message.value.event_sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(
      devices.map((message) => [
        message.value.device,
        message.value.code,
        message.value.pressed,
        message.value.repeat,
      ]),
    ).toEqual([
      ["keyboard", 65, true, false],
      ["keyboard", 65, true, true],
      ["keyboard", 65, false, false],
      ["mouse", 2, true, false],
      ["mouse", 2, false, false],
      ["keyboard", 66, true, false],
      ["keyboard", 66, false, false],
      ["keyboard", 67, true, false],
      ["keyboard", 67, false, false],
    ]);
    expect(messages.at(-1)).toMatchObject({
      type: "client_state_changed",
      value: { visible: false },
    });

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 3 })],
    });
    await vi.advanceTimersByTimeAsync(32);
    bridge.submitRuntime.mockClear();
    document.dispatchEvent(keyboardEvent("keydown", 68, { key: "d", code: "KeyD" }));
    await flushMicrotasks();
    expect(bridge.submitRuntime.mock.calls[0]?.[0]).toMatchObject({
      type: "device_state_changed",
      value: { event_sequence: 1, code: 68, pressed: true },
    });
  });

  it("shares one AnyKey input lock across keyboard, viewport, form, and button paths", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "any_key",
      wait_id: 24,
      submission_token: { epoch: 2, id: 11 },
    });
    bridge.submitRuntime.mockClear();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX" }));
    await Promise.all([
      store.continueFromViewport(),
      store.skip(),
      store.submitText(),
      store.activate({ epoch: 2, id: 99 }),
    ]);
    await flushMicrotasks();

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as unknown[] | undefined)?.[0]).toMatchObject({
      value: {
        wait_id: 24,
        token: { epoch: 2, id: 11 },
        intent: { type: "any_key", value: "x" },
        message_skip: false,
      },
    });
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(false);

    const nextWait = {
      kind: "any_key",
      wait_id: 25,
      submission_token: { epoch: 2, id: 12 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "opened", value: nextWait })],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
  });

  it("ignores repeated, modified, and modifier-only keys for AnyKey waits", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "any_key",
      wait_id: 26,
      submission_token: { epoch: 2, id: 13 },
    });
    bridge.submitRuntime.mockClear();

    for (const event of [
      new KeyboardEvent("keydown", { key: "x", repeat: true }),
      new KeyboardEvent("keydown", { key: "x", ctrlKey: true }),
      new KeyboardEvent("keydown", { key: "x", altKey: true }),
      new KeyboardEvent("keydown", { key: "x", metaKey: true }),
      new KeyboardEvent("keydown", { key: "x", shiftKey: true }),
      new KeyboardEvent("keydown", { key: "Control" }),
      new KeyboardEvent("keydown", { key: "Alt" }),
      new KeyboardEvent("keydown", { key: "Meta" }),
      new KeyboardEvent("keydown", { key: "Shift" }),
    ])
      document.dispatchEvent(event);
    await advanceUntil(
      () =>
        bridge.submitRuntime.mock.calls.filter(
          ([message]) => message.type === "device_state_changed",
        ).length === 9,
    );

    expect(
      bridge.submitRuntime.mock.calls.filter(([message]) => message.type === "input"),
    ).toHaveLength(0);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]) => message.type === "device_state_changed",
      ),
    ).toHaveLength(9);
    expect(store.canInteract).toBe(true);
  });

  it("releases the input lock when a wait closes or is updated to a new identity", async () => {
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();

    await store.continueFromViewport();
    expect(store.canInteract).toBe(false);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "closed", value: null })],
    });
    await vi.advanceTimersByTimeAsync(32);

    const nextWait = {
      kind: "enter_key",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "opened", value: nextWait })],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);

    await store.continueFromViewport();
    expect(store.canInteract).toBe(false);
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "updated",
          value: {
            ...nextWait,
            wait_id: 19,
            submission_token: { epoch: 2, id: 7 },
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
  });

  it("unlocks a rejected wait, isolates late rejections, and accepts the next wait", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "1";
    await store.submitText();
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "invalid input" }, 10)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    await store.submitText();

    const nextWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        runtimeEvent("command_rejected", { message: "late old rejection" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    store.prompt = "2";
    await store.submitText();

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 17, 18]);
  });

  it("unlocks the active wait after a transport submission failure", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockReset();
    bridge.submitRuntime.mockRejectedValueOnce(new Error("transport failed"));
    store.prompt = "1";

    await expect(store.submitText()).rejects.toThrow("transport failed");
    expect(store.canInteract).toBe(true);
    bridge.submitRuntime.mockResolvedValueOnce(11);
    await store.submitText();
    expect(store.canInteract).toBe(false);
  });

  it("logs an active-wait value mismatch without creating a corner notification", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "invalid";
    await store.submitText();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "command_rejected",
          { message: "input value does not match the active wait" },
          10,
        ),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(
      store.logs.some((entry) =>
        entry.message.includes("input value does not match the active wait"),
      ),
    ).toBe(true);
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input value does not match the active wait"),
      ),
    ).toBe(false);
    expect(store.canInteract).toBe(true);
  });

  it("retries one correlated timed-wait race on the next wait of the same kind", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
      deadline_ns: 1_000_000_000,
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "412";
    await store.submitText();

    const nextWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
      deadline_ns: 1_100_000_000,
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 18]);
    expect((inputs[1] as unknown[] | undefined)?.[0]).toMatchObject({
      value: { intent: { type: "commit_text", value: "412" }, message_skip: false },
    });
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input wait identity is stale"),
      ),
    ).toBe(false);
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 11)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(2);
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input wait identity is stale"),
      ),
    ).toBe(false);
    expect(store.canInteract).toBe(true);
  });

  it("keeps a message-skip intent across consecutive stale waits until a skip boundary", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    await store.skip();

    for (const [waitId, tokenId, rejectedMessageId] of [
      [18, 6, 11],
      [19, 7, 12],
    ]) {
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("wait_changed", {
            type: "opened",
            value: {
              kind: "enter_key",
              wait_id: waitId,
              submission_token: { epoch: 2, id: tokenId },
            },
          }),
          runtimeEvent(
            "command_rejected",
            { message: "input wait identity is stale" },
            rejectedMessageId,
          ),
        ],
      });
      await vi.advanceTimersByTimeAsync(32);
    }

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 18, 19]);
    expect(inputs.every((call: unknown[]) => (call[0] as any).value.message_skip === true)).toBe(
      true,
    );

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "opened",
          value: {
            kind: "enter_key",
            wait_id: 20,
            submission_token: { epoch: 2, id: 8 },
            stop_message_skip: true,
          },
        }),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 13),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(3);
    expect(store.canInteract).toBe(true);
  });

  it("resubmits message skip when a timed wait closes before its stale rejection arrives", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    await store.skip();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", {
          type: "opened",
          value: {
            kind: "enter_key",
            wait_id: 18,
            submission_token: { epoch: 2, id: 6 },
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 11),
        runtimeEvent("wait_changed", {
          type: "opened",
          value: {
            kind: "enter_key",
            wait_id: 19,
            submission_token: { epoch: 2, id: 7 },
            stop_message_skip: true,
          },
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    const inputs = bridge.submitRuntime.mock.calls.filter(
      ([message]: unknown[]) => (message as { type?: string }).type === "input",
    );
    expect(inputs.map((call: unknown[]) => (call[0] as any).value.wait_id)).toEqual([17, 18]);
    expect(inputs.every((call: unknown[]) => (call[0] as any).value.message_skip === true)).toBe(
      true,
    );
    expect(store.canInteract).toBe(true);
  });

  it("releases a stale input without notifying when no next wait is available", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "412";
    await store.submitText();

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "closed" }),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(1);
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input wait identity is stale"),
      ),
    ).toBe(false);

    const laterWait = {
      kind: "integer_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("wait_changed", { type: "opened", value: laterWait })],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(1);
  });

  it("releases a stale input without notifying when the next wait kind changes", async () => {
    let nextMessageId = 10;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    bridge.submitRuntime.mockClear();
    store.prompt = "412";
    await store.submitText();

    const nextWait = {
      kind: "string_value",
      wait_id: 18,
      submission_token: { epoch: 2, id: 6 },
    };
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 10),
      ],
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(store.canInteract).toBe(true);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "input",
      ),
    ).toHaveLength(1);
    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input wait identity is stale"),
      ),
    ).toBe(false);
  });

  it("does not advance a timed wait beside input and resumes timing after rejection", async () => {
    let nextMessageId = 20;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
      deadline_ns: 1_000_000_000,
    });
    nextMessageId = 20;
    bridge.submitRuntime.mockClear();
    store.prompt = "1";
    await store.submitText();
    await vi.advanceTimersByTimeAsync(64);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      ),
    ).toHaveLength(0);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "invalid input" }, 20)],
    });
    await vi.advanceTimersByTimeAsync(64);
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) => (message as { type?: string }).type === "advance_time",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("serializes undo with active-wait input and unlocks it on rejection", async () => {
    let nextMessageId = 30;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    const store = await storeWithInputWait(
      {
        kind: "integer_value",
        wait_id: 17,
        submission_token: { epoch: 2, id: 5 },
      },
      [runtimeEvent("input_undo_state_changed", { token: { epoch: 2, id: 9 } })],
    );
    bridge.submitRuntime.mockClear();

    await Promise.all([store.undo(), store.undo(), store.submitText()]);
    expect(bridge.submitRuntime.mock.calls.map((call: unknown[]) => (call[0] as any).type)).toEqual(
      ["input_undo_request"],
    );
    expect(store.canInteract).toBe(false);

    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("command_rejected", { message: "undo rejected" }, 30)],
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(store.canInteract).toBe(true);
    store.prompt = "2";
    await store.submitText();
    expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "input" }),
      undefined,
    );
  });

  it("filters only correlated stale projection rejections", async () => {
    let nextMessageId = 40;
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    bridge.pump.mockResolvedValueOnce(emptyBatch()).mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "command_rejected",
          { message: "projection observation does not match the canonical presentation" },
          40,
        ),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 999),
        runtimeEvent(
          "command_rejected",
          { message: "projection observation does not match the canonical presentation" },
          998,
        ),
      ],
    });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await store.projectViewport({
      width: 100,
      height: 80,
      lineColumns: 20,
      chromeWidth: 0,
      chromeHeight: 0,
    });
    await vi.advanceTimersByTimeAsync(32);

    expect(store.logs.some((entry) => entry.message.includes("input wait identity is stale"))).toBe(
      true,
    );
    expect(
      store.logNotifications.some((entry) =>
        entry.message.includes("input wait identity is stale"),
      ),
    ).toBe(false);
    expect(
      store.logs.filter((entry) =>
        entry.message.includes("projection observation does not match the canonical presentation"),
      ),
    ).toHaveLength(1);
  });

  it("cancels a pending compiled-cache writer before restarting the project", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    const restarting = store.restart();
    await flushMicrotasks();

    expect(bridge.cancelCompiledCacheExport).not.toHaveBeenCalled();
    expect(bridge.createSession).toHaveBeenCalledOnce();

    cacheWrite.resolve();
    await restarting;

    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
    expect(bridge.cancelCompiledCacheExport.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createSession.mock.invocationCallOrder[1]!,
    );
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(1);
  });

  it("cancels a pending compiled-cache writer before reloading the project", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    const reloading = store.reloadProject();
    await flushMicrotasks();

    expect(bridge.cancelCompiledCacheExport).not.toHaveBeenCalled();
    expect(bridge.reloadProject).not.toHaveBeenCalled();

    cacheWrite.resolve();
    await reloading;

    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(bridge.reloadProject).toHaveBeenCalledOnce();
    expect(bridge.cancelCompiledCacheExport.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.reloadProject.mock.invocationCallOrder[0]!,
    );
    expect(store.status).not.toBe("项目缓存已保存。");
    expect(store.status).not.toContain("正在后台生成项目缓存");
  });

  it("cleans up a rejected compiled-cache write without requesting another chunk", async () => {
    const cacheWrite = deferred<void>();
    const store = await storeWithPendingCompiledCacheWrite(cacheWrite.promise);

    cacheWrite.reject(undefined);
    await advanceUntil(() =>
      store.logs.some((entry) => entry.message.includes("项目缓存生成失败")),
    );

    expect(bridge.cancelCompiledCacheExport).toHaveBeenCalledOnce();
    expect(store.testTransferState().export).toBeNull();
    expect(store.logs.at(-1)?.message).toContain("项目缓存生成失败");
    expect(store.status).toBe("游戏运行中");
    expect(
      bridge.submitRuntime.mock.calls.filter(
        ([message]: unknown[]) =>
          (message as { type?: string }).type === "state_export_chunk_request",
      ),
    ).toHaveLength(1);
  });
});
