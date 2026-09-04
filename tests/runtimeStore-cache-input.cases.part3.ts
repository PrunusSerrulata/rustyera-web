import { bridge } from "./runtimeStoreTestSupport";
import { snakeCompatibility } from "./compatibilityTestSupport";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  deferred,
  emptyBatch,
  flushMicrotasks,
  keyboardEvent,
  storeWithInputWait,
  storeWithPendingCompiledCacheWrite,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store cache-input", () => {
  installRuntimeStoreTestHarness();
  afterEach(() => useRuntimeStore().teardown());

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
      keyboardEvent("keydown", 88, { key: "x", repeat: true }),
      keyboardEvent("keydown", 88, { key: "x", ctrlKey: true }),
      keyboardEvent("keydown", 88, { key: "x", altKey: true }),
      keyboardEvent("keydown", 88, { key: "x", metaKey: true }),
      keyboardEvent("keydown", 88, { key: "x", shiftKey: true }),
      keyboardEvent("keydown", 17, { key: "Control" }),
      keyboardEvent("keydown", 18, { key: "Alt" }),
      keyboardEvent("keydown", 91, { key: "Meta" }),
      keyboardEvent("keydown", 16, { key: "Shift" }),
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
    const context = { identity: snakeCompatibility(), stage: "protocol" };
    bridge.submitRuntime.mockImplementation(async () => nextMessageId++);
    bridge.pump.mockResolvedValueOnce(emptyBatch()).mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "command_rejected",
          {
            message: "projection observation does not match the canonical presentation",
            context,
          },
          40,
        ),
        runtimeEvent("command_rejected", { message: "input wait identity is stale" }, 999),
        runtimeEvent(
          "command_rejected",
          {
            message: "projection observation does not match the canonical presentation",
            context,
          },
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
    const projectionLogs = store.logs.filter((entry) =>
      entry.message.includes("projection observation does not match the canonical presentation"),
    );
    expect(projectionLogs).toHaveLength(1);
    expect(projectionLogs[0]?.message).toContain("profile=emuera.skia.snake@12/12 stage=protocol");
    expect(
      store.logNotifications.filter((entry) =>
        entry.message.includes("projection observation does not match the canonical presentation"),
      ),
    ).toHaveLength(1);
    expect(
      store.logNotifications.filter(
        (entry) => entry.message === "profile=emuera.skia.snake@12/12 stage=protocol",
      ),
    ).toHaveLength(0);
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
