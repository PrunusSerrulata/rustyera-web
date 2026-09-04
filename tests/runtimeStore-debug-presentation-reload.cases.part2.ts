import { getActivePinia } from "pinia";
import { installWebTestControl } from "@/testing/control";
import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  debugEvent,
  decodeServicePayload,
  deferred,
  emptyBatch,
  encodeServicePayload,
  storeWithInputWait,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store debug-presentation-reload", () => {
  installRuntimeStoreTestHarness();

  it("keeps presentation services ordered between synchronous deltas", async () => {
    const line = (lineId: number, text: string) => ({
      line_id: lineId,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [{ type: "text", text, style: {} }],
    });
    const query = [
      ...encodeServicePayload(
        new Map<number, unknown>([
          [0, "probe"],
          [1, 0],
        ]),
      ),
    ];
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "service ordering",
          history: { logical_lines: [line(1, "old")] },
          input_wait: null,
        }),
        runtimeEvent(
          "service_request",
          {
            request_id: 1,
            kind: "presentation_query",
            operation: "get_display_line",
            operation_version: { major: 1, minor: 0 },
            payload: query,
          },
          41,
        ),
        runtimeEvent("presentation_delta", {
          base_revision: 1,
          new_revision: 2,
          operations: [
            { type: "delete_lines", count: 1 },
            { type: "append_line", line: line(2, "new") },
          ],
        }),
        runtimeEvent(
          "service_request",
          {
            request_id: 2,
            kind: "presentation_query",
            operation: "get_display_line",
            operation_version: { major: 1, minor: 0 },
            payload: query,
          },
          42,
        ),
      ],
    });
    const store = useRuntimeStore();

    await store.enableDebug();

    const responses = bridge.submitRuntime.mock.calls
      .map((call) => call as unknown as [message: any, correlationId?: number])
      .filter(([message]) => message.type === "service_response");
    expect(responses.map(([, correlationId]) => correlationId)).toEqual([41, 42]);
    expect(
      responses.map(([message]) => decodeServicePayload(message.value.result.payload)),
    ).toEqual([
      new Map<number, unknown>([
        [0, "probe"],
        [1, "old"],
      ]),
      new Map<number, unknown>([
        [0, "probe"],
        [1, "new"],
      ]),
    ]);
  });

  it("waits for delta-gap resynchronization before handling later events", async () => {
    const resynchronized = deferred<number>();
    bridge.submitRuntime.mockImplementation(async (message: any) => {
      if (message.type === "resynchronize") return resynchronized.promise;
      return 1;
    });
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "before gap",
          history: { logical_lines: [] },
          input_wait: null,
        }),
        runtimeEvent("presentation_delta", {
          base_revision: 9,
          new_revision: 10,
          operations: [],
        }),
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 7 }),
      ],
    });
    const store = useRuntimeStore();

    const enabling = store.enableDebug();
    await advanceUntil(() =>
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) => (message as { type?: string }).type === "resynchronize",
      ),
    );

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      { type: "resynchronize", value: { after_sequence: null } },
      undefined,
    );
    expect(store.phase).not.toBe("waiting_input");
    expect(store.runtimeEpoch).not.toBe(7);

    resynchronized.resolve(17);
    await enabling;

    expect(store.phase).toBe("waiting_input");
    expect(store.runtimeEpoch).toBe(7);
    expect(store.logs.some((entry) => entry.message.includes("展示 revision 不连续"))).toBe(true);
  });

  it("attaches without pausing and retries a requested pause with a renewed grant", async () => {
    const oldToken = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const newToken = { grant_id: { high: 1, low: 2 }, program_generation: 2 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: oldToken }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent("grant", { token: newToken }),
          runtimeEvent("log", {
            level: "warning",
            message:
              "debug request failed [PermissionDenied]: debug grant is stale or belongs to another session generation",
          }),
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(1);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
    expect(store.singleStepEnabled).toBe(false);

    await store.openDebugDialog("variables");
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: oldToken, command: { type: "pause" } },
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant: newToken, command: { type: "pause" } },
    });
    expect(store.logs).toEqual([]);
  });

  it.each(["resume", "newer_stop", "faulted", "early_response", "early_error", "early_newer_stop"])(
    "keeps typed BigInt inspection bound to its exact stop: %s",
    async (ending) => {
      vi.stubEnv("VITE_RUSTYERA_TEST", "1");
      const grant = { grant_id: { high: 1n, low: 1n }, program_generation: 9007199254740993n };
      const stop = {
        session_epoch: 2n,
        pause_epoch: 9007199254740993n,
        program_generation: grant.program_generation,
        runtime_revision: 8n,
      };
      const wait = { kind: "integer_value", wait_id: 7n, submission_token: { epoch: 2n, id: 7n } };
      const fault = { code: "vm_fault", message: "fixture failure must remain visible" };
      const store = await storeWithInputWait(wait, [
        debugEvent("grant", { token: grant }),
        ...(ending === "faulted"
          ? [
              runtimeEvent("wait_changed", { type: "closed" }),
              runtimeEvent("fault", fault),
              runtimeEvent("state_changed", { phase: "faulted", epoch: 2n }),
            ]
          : []),
      ]);
      let nextId = 20;
      const pending: any[] = [];
      bridge.pump.mockImplementation(async () => ({ ...emptyBatch(), events: pending.splice(0) }));
      bridge.submitDebug.mockImplementation(async (message: any) => {
        const id = nextId++;
        const command = message.value.command;
        const response = (value: unknown) => pending.push(debugEvent("response", value, id));
        if (command.type === "pause") {
          pending.push(runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2n }));
          response({ type: "accepted" });
          pending.push(debugEvent("stopped", { stop, reason: { type: "pause_requested" } }));
        } else if (command.type === "list_fibers") {
          response({
            type: "fiber_page",
            value: { stop: command.stop, fibers: [], next_cursor: null },
          });
        } else if (command.type === "list_variables") {
          response({
            type: "variable_page",
            value: {
              stop: command.stop,
              variables: [
                { name: "RESULT", symbol_key: [1], storage: "global", dimensions: [100] },
              ],
              next_cursor: null,
            },
          });
        } else if (command.type === "read_variable") {
          if (ending === "early_error")
            pending.push(
              debugEvent(
                "error",
                { code: "invalid_request", message: "actual read rejection" },
                id,
              ),
            );
          else
            response({
              type: "variable_value",
              value: {
                reference: command.value,
                value: { type: "integer", value: -9223372036854775808n },
              },
            });
          if (ending === "newer_stop" || ending === "early_newer_stop")
            pending.push(
              debugEvent("stopped", {
                stop: { ...stop, pause_epoch: stop.pause_epoch + 1n },
                reason: { type: "pause_requested" },
              }),
            );
          if (ending.startsWith("early_")) {
            // Model native pump delivery before submit_debug's IPC promise returns its ID.
            await new Promise((resolve) => window.setTimeout(resolve, 32));
            const records = (window.__RUSTYERA_TEST__!.snapshot().serviceEvidence as any).records;
            expect(
              records.some(
                (row: any) =>
                  row.channel === "debug" &&
                  row.direction === "receive" &&
                  String(row.correlationId) === String(id),
              ),
            ).toBe(true);
            expect(
              records.some(
                (row: any) =>
                  row.channel === "debug" &&
                  row.direction === "send" &&
                  String(row.messageId) === String(id),
              ),
            ).toBe(false);
          }
        } else if (command.type === "continue") {
          pending.push(
            runtimeEvent("state_changed", {
              phase: ending === "faulted" ? "faulted" : "waiting_input",
              epoch: 2n,
            }),
          );
          response({ type: "accepted" });
        } else throw new Error(`unexpected debug command ${command.type}`);
        return id;
      });
      let result: any,
        failure: unknown,
        done = false;
      installWebTestControl(getActivePinia()!);
      const inspecting = window
        .__RUSTYERA_TEST__!.inspectTyped(["RESULT:0"])
        .then(
          (value) => {
            result = value;
          },
          (error) => {
            failure = error;
          },
        )
        .finally(() => {
          done = true;
          delete window.__RUSTYERA_TEST__;
        });
      await advanceUntil(() => done, 100);
      await inspecting;
      const continues = bridge.submitDebug.mock.calls.filter(
        ([message]: any[]) => message.value?.command?.type === "continue",
      );
      if (ending === "early_error") {
        expect(String(failure)).toContain("actual read rejection");
        expect(continues).toHaveLength(1);
        expect(continues[0][0].value.command.stop).toEqual(stop);
        expect(store.canInteract).toBe(true);
        expect(store.presentation.inputWait).toEqual(wait);
      } else if (ending !== "newer_stop" && ending !== "early_newer_stop") {
        expect(failure).toBeUndefined();
        expect(result.values["RESULT:0"]).toMatchObject({
          present: true,
          value: { type: "integer", value: "-9223372036854775808" },
        });
        expect(() => JSON.stringify(result)).not.toThrow();
        expect(result.stop.pause_epoch).toBe("9007199254740993");
        expect(continues).toHaveLength(1);
        expect(continues[0][0].value.command.stop).toEqual(stop);
        if (ending === "faulted") {
          expect(store.phase).toBe("faulted");
          expect(store.fault).toEqual(fault);
          expect(store.canInteract).toBe(false);
        } else {
          expect(store.canInteract).toBe(true);
          expect(store.presentation.inputWait).toEqual(wait);
        }
      } else {
        expect(String(failure)).toContain("typed watch stop or session changed");
        expect(continues).toHaveLength(0);
        expect(store.debugStop.stop.pause_epoch).toBe(stop.pause_epoch + 1n);
      }
    },
  );

  it("handles an early production pause error before register-only submission completes", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const store = await storeWithInputWait(
      { kind: "integer_value", wait_id: 7, submission_token: { epoch: 2, id: 7 } },
      [debugEvent("grant", { token: grant })],
    );
    const pending: any[] = [];
    const setupSubmissions = bridge.submitDebug.mock.calls.length;
    let nextId = 47;
    bridge.pump.mockImplementation(async () => ({ ...emptyBatch(), events: pending.splice(0) }));
    bridge.submitDebug.mockImplementation(async () => {
      const id = nextId++;
      pending.push(debugEvent("error", { code: "invalid_request", message: "pause rejected" }, id));
      await new Promise((resolve) => window.setTimeout(resolve, 32));
      return id;
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let done = false;
      const pausing = store.openDebugDialog("console").finally(() => {
        done = true;
      });
      await advanceUntil(() => done);
      await pausing;
      expect(bridge.submitDebug).toHaveBeenCalledTimes(setupSubmissions + attempt + 1);
    }
    expect(store.logs.filter((entry) => entry.message === "pause rejected")).toHaveLength(2);
    expect(store.debugStop).toBeNull();
  });

  it("continues after the last debugger surface closes without enabling single-step mode", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            { stop, selected_fiber: 7, reason: { type: "pause_requested" } },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 4),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.openDebugDialog("console");
    expect(store.singleStepEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(16);

    const closing = store.closeDebugDialog("console");
    expect(bridge.submitDebug).toHaveBeenLastCalledWith({
      type: "request",
      value: { grant, command: { type: "continue", stop } },
    });
    await vi.advanceTimersByTimeAsync(16);
    await closing;

    expect(store.debugConsoleOpen).toBe(false);
    expect(store.singleStepEnabled).toBe(false);
    expect(store.debugStop).toBeNull();
  });

  it("renegotiates when the runtime rejects the current grant", async () => {
    const token = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            {
              code: "permission_denied",
              message: "debug grant is stale or belongs to another session generation",
            },
            2,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.submitDebug).toHaveBeenCalledTimes(3);
    expect(bridge.submitDebug).toHaveBeenLastCalledWith(expect.objectContaining({ type: "hello" }));
  });

  it("loads open debugger surfaces after stopping and selects a populated call stack", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            {
              stop,
              selected_fiber: 7,
              reason: { type: "pause_requested" },
              source: { relative_path: "erb/debug.erb", line: 3 },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "variable_page",
              value: {
                stop,
                variables: [
                  {
                    symbol_key: [1],
                    name: "RESULT",
                    storage: "global",
                    value_kind: "integer",
                    dimensions: [],
                  },
                ],
              },
            },
            4,
          ),
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "debug_paused", frame_count: 2 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "call_stack",
              value: {
                stop,
                fiber_id: 7,
                frames: [{ frame_id: 9, function_name: "EVENTFIRST", instruction: 12 }],
              },
            },
            5,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.openDebugDialog("variables");
    await store.openDebugDialog("stack");
    await vi.advanceTimersByTimeAsync(48);

    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_variables", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "list_fibers", stop, cursor: null, limit: 256 } },
    });
    expect(bridge.submitDebug).toHaveBeenCalledWith({
      type: "request",
      value: { grant, command: { type: "read_call_stack", stop, fiber_id: 7 } },
    });
    expect(store.debugVariables.map((variable) => variable.name)).toEqual(["RESULT"]);
    expect(store.debugFibers.map((fiber) => fiber.fiber_id)).toEqual([7]);
    expect(store.debugFrames.map((frame) => frame.function_name)).toEqual(["EVENTFIRST"]);
  });

  it("steps only runnable fibers and restores the stop when the runtime rejects the step", async () => {
    const grant = { grant_id: { high: 1, low: 1 }, program_generation: 1 };
    const stop = {
      session_epoch: 2,
      pause_epoch: 3,
      program_generation: 1,
      runtime_revision: 4,
    };
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "running", epoch: 2 }),
          debugEvent("grant", { token: grant }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "debug_paused", epoch: 2 }),
          debugEvent("response", { type: "accepted" }, 2),
          debugEvent(
            "stopped",
            {
              stop,
              selected_fiber: 7,
              reason: { type: "pause_requested" },
              source: { relative_path: "erb/debug.erb", line: 3 },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "response",
            {
              type: "fiber_page",
              value: {
                stop,
                fibers: [{ fiber_id: 7, state: "waiting_host", frame_count: 1 }],
              },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          debugEvent(
            "error",
            { code: "invalid_state", message: "only a runnable fiber can be stepped" },
            4,
          ),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);
    await store.openDebugDialog("console");
    await vi.advanceTimersByTimeAsync(32);

    expect(store.canStepDebug).toBe(false);
    await store.toggleSingleStep();
    expect(store.promptPlaceholder).toBe("单步暂停：erb/debug.erb:4（F10 继续）");
    store.debugFibers = [{ fiber_id: 7, state: "runnable", frame_count: 1 }];
    expect(store.canStepDebug).toBe(true);

    const stepping = store.stepDebug();
    const rejectedStep = expect(stepping).rejects.toThrow("only a runnable fiber can be stepped");
    await vi.advanceTimersByTimeAsync(16);
    await rejectedStep;
    expect(store.debugStop).toEqual(expect.objectContaining({ stop }));
  });
});
