import { bridge } from "./runtimeStoreTestSupport";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  deferred,
  emptyBatch,
  flushMicrotasks,
  keyboardEvent,
  storeWithInputWait,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store cache-input", () => {
  installRuntimeStoreTestHarness();
  afterEach(() => useRuntimeStore().teardown());

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

  it("submits a physical secondary-button release before native message-skip pumping", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "enter_key",
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    const order: string[] = [];
    bridge.submitRuntime.mockImplementation(async (message) => {
      if (message.type === "device_state_changed")
        order.push(message.value.pressed ? "mouse-down" : "mouse-up");
      return 40;
    });
    const submitRuntimeAndPump = vi.fn(async () => {
      order.push("input-and-pump");
      return { ...emptyBatch(), submittedMessageId: 41 };
    });
    bridge.submitRuntimeAndPump = submitRuntimeAndPump;

    document.dispatchEvent(new MouseEvent("mousedown", { button: 2, clientX: 17, clientY: 23 }));
    const skipping = store.skip();
    await flushMicrotasks();

    expect(order).toEqual(["mouse-down"]);
    expect(submitRuntimeAndPump).not.toHaveBeenCalled();

    document.dispatchEvent(new MouseEvent("mouseup", { button: 2, clientX: 18, clientY: 24 }));
    await skipping;

    expect(order).toEqual(["mouse-down", "mouse-up", "input-and-pump"]);
    expect(submitRuntimeAndPump).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "input",
        value: expect.objectContaining({
          wait_id: 22,
          intent: { type: "enter" },
          message_skip: true,
        }),
      }),
      undefined,
    );
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

  it("consumes the current stop-message-skip wait with a secondary action", async () => {
    const store = await storeWithInputWait({
      kind: "enter_key",
      stop_message_skip: true,
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
    expect(bridge.submitRuntime).toHaveBeenLastCalledWith(
      {
        type: "input",
        value: expect.objectContaining({
          wait_id: 22,
          token: { epoch: 2, id: 9 },
          intent: { type: "enter" },
          message_skip: true,
        }),
      },
      undefined,
    );
  });

  it("only balances the compatibility mouse event at a non-message wait", async () => {
    const store = await storeWithInputWait({
      kind: "integer_value",
      wait_id: 22,
      submission_token: { epoch: 2, id: 9 },
    });
    bridge.submitRuntime.mockClear();

    await store.skip();

    expect(bridge.submitRuntime.mock.calls.map(([message]) => message.type)).toEqual([
      "device_state_changed",
      "device_state_changed",
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

  it("prefers the physical key identity when WebKit reports an inconsistent keyCode", async () => {
    const store = useRuntimeStore();
    await store.initialize();
    await storeWithInputWait({
      kind: "integer_value",
      wait_id: 23,
      submission_token: { epoch: 2, id: 10 },
    });
    bridge.submitRuntime.mockClear();

    document.dispatchEvent(keyboardEvent("keydown", 97, { key: "a", code: "KeyA" }));
    document.dispatchEvent(keyboardEvent("keyup", 97, { key: "a", code: "KeyA" }));
    document.dispatchEvent(keyboardEvent("keydown", 0, { key: "", code: "Unidentified" }));
    await advanceUntil(
      () =>
        bridge.submitRuntime.mock.calls.filter(
          ([message]) => message.type === "device_state_changed",
        ).length === 2,
    );

    expect(
      bridge.submitRuntime.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "device_state_changed"),
    ).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ code: 65, pressed: true, event_sequence: 1 }),
      }),
      expect.objectContaining({
        value: expect.objectContaining({ code: 65, pressed: false, event_sequence: 2 }),
      }),
    ]);
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
});
