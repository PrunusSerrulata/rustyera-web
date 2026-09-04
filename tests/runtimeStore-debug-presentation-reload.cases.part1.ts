import { bridge } from "./runtimeStoreTestSupport";
import { watch } from "vue";
import { HtmlMeasurementProvider } from "@/platform/htmlMeasurement";
import { encodeProjectionServicePayload } from "@/core/serviceCodec";
import { projectionMap, type ProjectionQueryContext } from "@/core/runtimeServiceProtocol";
import { RuntimeServiceError } from "@/core/runtimeServiceError";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  advanceUntil,
  decodeServicePayload,
  deferred,
  emptyBatch,
  flushMicrotasks,
  plainLine,
  storeWithInputWait,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";

function storeHtmlQuery(context: ProjectionQueryContext) {
  const color = new Map([
    [0, 192],
    [1, 192],
    [2, 192],
    [3, 255],
  ]);
  const style = new Map<number, unknown>([
    [0, color],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
    [7, 18000],
  ]);
  const settings = new Map<number, unknown>([
    [0, 640000],
    [1, 20000],
    [2, color],
    [3, color],
    [4, 1000],
    [5, true],
    [6, false],
    [7, 480000],
  ]);
  const document = new Map<number, unknown>([[0, [[0, ["a", 0, 1]]]]]);
  const probe = new Map<number, unknown>([
    [0, 0],
    [1, document],
    [2, 0],
    [3, []],
  ]);
  return {
    request_id: 901,
    kind: "presentation_query",
    operation: "html_string_len",
    operation_version: { major: 2, minor: 0 },
    payload: [
      ...encodeProjectionServicePayload(
        new Map<number, unknown>([
          [0, projectionMap(context)],
          [
            1,
            new Map([
              [0, style],
              [1, style],
              [2, settings],
            ]),
          ],
          [2, [probe]],
        ]),
      ),
    ],
  };
}
const providerLifetimeEndings = [
  "complete",
  "cancel",
  "epoch",
  "fault",
  "teardown",
  "resize",
  "resize-observation",
  "preferences",
  "layout",
] as const;
describe("runtime store debug-presentation-reload", () => {
  installRuntimeStoreTestHarness();

  it.each(providerLifetimeEndings)(
    "binds HTML provider lifetime to the confirmed viewport through %s",
    async (ending) => {
      const viewport = document.createElement("main");
      viewport.className = "game-viewport";
      let width = 640;
      Object.defineProperties(viewport, {
        clientWidth: { get: () => width },
        clientHeight: { value: 480 },
      });
      document.body.append(viewport);
      const gate = deferred<void>();
      let signal: AbortSignal | undefined;
      const measured = vi
        .spyOn(HtmlMeasurementProvider.prototype, "measure")
        .mockImplementation(async (_probe, binding, guard) => {
          signal = guard.signal;
          expect(binding.viewport).toBe(viewport);
          expect(binding.resourceBridge).toBe(bridge);
          const measuredWidth = binding.viewport.clientWidth;
          const measuredHeight = binding.viewport.clientHeight;
          await gate.promise;
          guard.assertCurrent();
          if (
            binding.viewport.clientWidth !== measuredWidth ||
            binding.viewport.clientHeight !== measuredHeight
          )
            throw new RuntimeServiceError(
              "stale_projection",
              "HTML viewport geometry changed during measurement",
            );
          return {
            context: binding.context,
            advancePx: 9.25,
            cuts: [],
            textNodes: [],
            firstRow: { advancePx: 9.25, heightPx: 18, fragments: [] },
          };
        });
      const cleared = vi.spyOn(HtmlMeasurementProvider.prototype, "clear");
      const store = await storeWithInputWait({
        kind: "enter_key",
        wait_id: 17,
        submission_token: { epoch: 2, id: 5 },
      });
      try {
        await store.projectViewport({
          width: 640,
          height: 480,
          lineColumns: 80,
          chromeWidth: 0,
          chromeHeight: 0,
        });
        const observations = bridge.submitRuntime.mock.calls
          .map(([message]) => message)
          .filter((message) => message.type === "projection_observation");
        const observation = observations[observations.length - 1].value;
        bridge.pump.mockResolvedValueOnce({
          ...emptyBatch(),
          events: [
            runtimeEvent(
              "service_request",
              storeHtmlQuery({
                presentationRevision: 1,
                environmentRevision: observation.environment_revision,
                projectionSpaceRevision: observation.projection_space_revision,
              }),
              941,
              2,
            ),
          ],
        });
        await advanceUntil(() => measured.mock.calls.length === 1);
        cleared.mockClear();
        if (ending === "teardown") store.teardown();
        else if (ending === "resize") width = 641;
        else if (ending === "resize-observation") {
          const projectionCount = bridge.submitRuntime.mock.calls.filter(
            ([message]) => message.type === "projection_observation",
          ).length;
          width = 641;
          await store.projectViewport({
            width: 641,
            height: 480,
            lineColumns: 80,
            chromeWidth: 0,
            chromeHeight: 0,
          });
          expect(
            bridge.submitRuntime.mock.calls.filter(
              ([message]) => message.type === "projection_observation",
            ),
          ).toHaveLength(projectionCount);
        } else if (ending === "preferences") store.preferences.fontSizeOverridePx = 23;
        else if (ending === "layout") {
          const projectionCount = bridge.submitRuntime.mock.calls.filter(
            ([message]) => message.type === "projection_observation",
          ).length;
          store.prompt = "cleared-after-input";
          await store.projectViewport(
            {
              width: 640,
              height: 480,
              lineColumns: 80,
              chromeWidth: 0,
              chromeHeight: 0,
            },
            "history-layout-changed",
          );
          expect(
            bridge.submitRuntime.mock.calls.filter(
              ([message]) => message.type === "projection_observation",
            ),
          ).toHaveLength(projectionCount);
        } else if (ending !== "complete") {
          const event =
            ending === "cancel"
              ? runtimeEvent(
                  "cancel_external_request",
                  { kind: "service", request_id: 901 },
                  undefined,
                  2,
                )
              : ending === "epoch"
                ? runtimeEvent("state_changed", { phase: "waiting_input", epoch: 3 }, undefined, 3)
                : runtimeEvent(
                    "fault",
                    { code: "fixture.fault", message: "stop measurement" },
                    undefined,
                    2,
                  );
          bridge.pump.mockResolvedValueOnce({ ...emptyBatch(), events: [event] });
          await advanceUntil(() => signal?.aborted === true);
        }
        if (ending === "layout")
          bridge.pump.mockResolvedValueOnce({
            ...emptyBatch(),
            events: [
              runtimeEvent(
                "service_request",
                {
                  ...storeHtmlQuery({
                    presentationRevision: 1,
                    environmentRevision: observation.environment_revision,
                    projectionSpaceRevision: observation.projection_space_revision,
                  }),
                  request_id: 902,
                },
                942,
                2,
              ),
            ],
          });
        gate.resolve();
        if (
          ["complete", "resize", "resize-observation", "preferences", "layout"].includes(ending)
        ) {
          await advanceUntil(() =>
            bridge.submitRuntime.mock.calls.some(
              ([message]) => message.type === "service_response",
            ),
          );
          const response = bridge.submitRuntime.mock.calls.find(
            ([message]) => message.type === "service_response",
          )!;
          expect(response[1]).toBe(941);
          if (["complete", "layout"].includes(ending))
            expect(
              (decodeServicePayload(response[0].value.result.payload) as Map<number, any>)
                .get(1)[0]
                .get(1),
            ).toEqual([0, [9250, []]]);
          else expect(response[0].value.result.error.code).toBe("frontend.stale_projection");
          if (["layout", "resize-observation"].includes(ending)) {
            await advanceUntil(
              () =>
                bridge.submitRuntime.mock.calls.filter(
                  ([message]) => message.type === "projection_observation",
                ).length > observations.length,
            );
            const messageTypes = bridge.submitRuntime.mock.calls.map(([message]) => message.type);
            expect(
              bridge.submitRuntime.mock.calls.filter(
                ([message]) => message.type === "service_response",
              ),
            ).toHaveLength(ending === "layout" ? 2 : 1);
            expect(messageTypes.lastIndexOf("service_response")).toBeLessThan(
              messageTypes.lastIndexOf("projection_observation"),
            );
          }
        } else {
          await flushMicrotasks();
          await flushMicrotasks();
          expect(
            bridge.submitRuntime.mock.calls.some(
              ([message]) => message.type === "service_response",
            ),
          ).toBe(false);
          expect(signal?.aborted).toBe(true);
          if (ending !== "cancel") expect(cleared).toHaveBeenCalled();
          else expect(cleared).not.toHaveBeenCalled(); // Cancelling one request must not cancel unrelated provider work.
        }
      } finally {
        gate.resolve();
        store.teardown();
        measured.mockRestore();
        cleared.mockRestore();
      }
    },
  );

  it("keeps Runtime text styles in the presentation identity during an HTML query", async () => {
    const viewport = document.createElement("main");
    viewport.className = "game-viewport";
    Object.defineProperties(viewport, {
      clientWidth: { value: 640 },
      clientHeight: { value: 480 },
    });
    document.body.append(viewport);
    const measured = vi
      .spyOn(HtmlMeasurementProvider.prototype, "measure")
      .mockImplementation(async (_probe, binding, guard) => {
        guard.assertCurrent();
        return {
          context: binding.context,
          advancePx: 9.25,
          cuts: [],
          textNodes: [],
          firstRow: { advancePx: 9.25, heightPx: 18, fragments: [] },
        };
      });
    const store = await storeWithInputWait({
      kind: "enter_key",
      wait_id: 17,
      submission_token: { epoch: 2, id: 5 },
    });
    try {
      await store.projectViewport({
        width: 640,
        height: 480,
        lineColumns: 80,
        chromeWidth: 0,
        chromeHeight: 0,
      });
      const observation = bridge.submitRuntime.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "projection_observation")
        .at(-1)!.value;
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
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
                      type: "text",
                      text: "styled output",
                      style: {
                        foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
                        bold: false,
                        italic: false,
                        underline: false,
                        strikeout: false,
                        font_family: "SimHei",
                        font_millipixels: 16_000,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          runtimeEvent(
            "service_request",
            storeHtmlQuery({
              presentationRevision: 2,
              environmentRevision: observation.environment_revision,
              projectionSpaceRevision: observation.projection_space_revision,
            }),
            941,
            2,
          ),
        ],
      });

      await store.enableDebug();
      await advanceUntil(() =>
        bridge.submitRuntime.mock.calls.some(([message]) => message.type === "service_response"),
      );
      const response = bridge.submitRuntime.mock.calls.find(
        ([message]) => message.type === "service_response",
      )![0];
      expect(response.value.result.type).toBe("ready");
      expect(measured).toHaveBeenCalledOnce();
    } finally {
      store.teardown();
      measured.mockRestore();
    }
  });

  it.each(["tauri", "browser"] as const)(
    "keeps all 41 save-slot measurements off-screen until the next input wait in %s",
    async (kind) => {
      bridge.kind = kind;
      const viewport = document.createElement("main");
      viewport.className = "game-viewport";
      Object.defineProperties(viewport, {
        clientWidth: { value: 640 },
        clientHeight: { value: 480 },
      });
      document.body.append(viewport);
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
        wait_id: 17,
        submission_token: { epoch: 2, id: 5 },
      };
      const store = await storeWithInputWait(firstWait, [
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "title menu",
          history: { logical_lines: [line(1, "Continue game")] },
          input_wait: firstWait,
        }),
      ]);
      let measuredSlots = 0;
      const measured = vi
        .spyOn(HtmlMeasurementProvider.prototype, "measure")
        .mockImplementation(async (_probe, binding, guard) => {
          guard.assertCurrent();
          measuredSlots += 1;
          expect(binding.context.presentationRevision).toBe(measuredSlots + 1);
          expect(binding.resources).toMatchObject({ animation_timer_ms: 37 });
          expect(store.presentation.revision).toBe(1);
          expect(store.presentation.lines.map(plainLine)).toEqual(["Continue game"]);
          return {
            context: binding.context,
            advancePx: 36,
            cuts: [],
            textNodes: [],
            firstRow: { advancePx: 36, heightPx: 18, fragments: [] },
          };
        });
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      try {
        await store.projectViewport({
          width: 640,
          height: 480,
          lineColumns: 80,
          chromeWidth: 0,
          chromeHeight: 0,
        });
        const observation = bridge.submitRuntime.mock.calls
          .map(([message]) => message)
          .filter((message) => message.type === "projection_observation")
          .at(-1)!.value;
        const paint = vi.fn((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });
        vi.stubGlobal("requestAnimationFrame", paint);
        const slotLines = Array.from({ length: 41 }, (_, slot) => `[${slot}] ----`);
        for (const [slot, text] of slotLines.entries()) {
          bridge.pump.mockResolvedValueOnce({
            ...emptyBatch(),
            events: [
              runtimeEvent("presentation_delta", {
                base_revision: slot + 1,
                new_revision: slot + 2,
                operations: [
                  ...(slot === 0
                    ? [
                        { type: "set_input_wait", input_wait: null },
                        { type: "set_redraw", redraw: { enabled: false } },
                        { type: "clear" },
                        {
                          type: "set_resources",
                          resources: { sprites: [], canvases: [], animation_timer_ms: 37 },
                        },
                      ]
                    : []),
                  { type: "append_line", line: line(slot + 2, text) },
                ],
              }),
              runtimeEvent(
                "service_request",
                {
                  ...storeHtmlQuery({
                    presentationRevision: slot + 2,
                    environmentRevision: observation.environment_revision,
                    projectionSpaceRevision: observation.projection_space_revision,
                  }),
                  request_id: 901 + slot,
                },
                941 + slot,
                2,
              ),
            ],
          });
          await advanceUntil(
            () =>
              bridge.submitRuntime.mock.calls.filter(
                ([message]) => message.type === "service_response",
              ).length ===
              slot + 1,
          );
          const response = bridge.submitRuntime.mock.calls
            .map(([message]) => message)
            .filter((message) => message.type === "service_response")
            .at(-1)!;
          expect(response.value.result.type).toBe("ready");
          expect(store.presentation.revision).toBe(1);
          expect(store.presentation.lines.map(plainLine)).toEqual(["Continue game"]);
          expect(store.presentation.resources.animation_timer_ms).toBe(0);
        }
        expect(measured).toHaveBeenCalledTimes(41);
        expect(paint).not.toHaveBeenCalled();
        const nextWait = {
          ...firstWait,
          wait_id: 18,
          submission_token: { epoch: 2, id: 6 },
        };
        bridge.pump.mockResolvedValueOnce({
          ...emptyBatch(),
          events: [
            runtimeEvent("presentation_delta", {
              base_revision: 42,
              new_revision: 43,
              operations: [
                { type: "set_redraw", redraw: { enabled: true } },
                { type: "set_input_wait", input_wait: nextWait },
              ],
            }),
            runtimeEvent("wait_changed", { type: "opened", value: nextWait }),
          ],
        });
        await advanceUntil(() => store.presentation.revision === 43);
        expect(store.presentation.lines.map(plainLine)).toEqual(slotLines);
        expect(store.presentation.inputWait?.wait_id).toBe(18);
        expect(store.presentation.resources.animation_timer_ms).toBe(37);
      } finally {
        store.teardown();
        measured.mockRestore();
        visibility.mockRestore();
      }
    },
  );

  it("rejects HTML queries without a confirmed mounted viewport before DOM measurement", async () => {
    const measured = vi.spyOn(HtmlMeasurementProvider.prototype, "measure");
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent(
          "service_request",
          storeHtmlQuery({
            presentationRevision: 0,
            environmentRevision: 1,
            projectionSpaceRevision: 1,
          }),
          941,
        ),
      ],
    });
    const store = useRuntimeStore();
    try {
      await store.enableDebug();
      await advanceUntil(() =>
        bridge.submitRuntime.mock.calls.some(([message]) => message.type === "service_response"),
      );
      const response = bridge.submitRuntime.mock.calls.find(
        ([message]) => message.type === "service_response",
      )!;
      expect(response[0].value.result.error.code).toBe("frontend.stale_projection");
      expect(measured).not.toHaveBeenCalled();
    } finally {
      store.teardown();
      measured.mockRestore();
    }
  });

  it("publishes one final Vue observation for a batch of synchronous runtime events", async () => {
    const wait = {
      kind: "enter_key",
      wait_id: 31,
      submission_token: { epoch: 4, id: 9 },
    };
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("state_changed", { phase: "waiting_input", epoch: 4 }),
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "batched",
          history: { logical_lines: [] },
          input_wait: null,
        }),
        runtimeEvent("presentation_delta", {
          base_revision: 1,
          new_revision: 2,
          operations: [{ type: "set_input_wait", input_wait: wait }],
        }),
        runtimeEvent("wait_changed", { type: "opened", value: wait }),
      ],
    });
    const store = useRuntimeStore();
    const observations: unknown[] = [];
    const stop = watch(
      () => [store.phase, store.presentation.revision, store.presentation.inputWait?.wait_id],
      (value) => observations.push([...value]),
    );

    await store.enableDebug();
    await flushMicrotasks();

    expect(observations).toEqual([["waiting_input", 2, 31]]);
    stop();
  });

  it("publishes a present-now revision before acknowledging the effect", async () => {
    bridge.kind = "browser";
    let paint: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    });
    const wait = {
      kind: "string_value",
      wait_id: 31,
      submission_token: { epoch: 4, id: 9 },
    };
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "before present now",
          history: { logical_lines: [] },
          input_wait: wait,
        }),
        runtimeEvent("wait_changed", { type: "opened", value: wait }),
        runtimeEvent("wait_changed", { type: "closed", value: null }),
        runtimeEvent("presentation_delta", {
          base_revision: 1,
          new_revision: 2,
          operations: [
            { type: "set_title", title: "present now" },
            { type: "set_redraw", redraw: { enabled: true } },
          ],
        }),
        runtimeEvent("effect_batch", {
          effects: [
            {
              effect_id: 7,
              kind: { type: "present_now", value: { presentation_revision: 2 } },
            },
          ],
        }),
      ],
    });
    const store = useRuntimeStore();

    const enabling = store.enableDebug();
    await advanceUntil(() => store.presentation.revision === 2);

    expect(store.presentation.revision).toBe(2);
    expect(document.title).toBe("present now");
    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) => (message as { type?: string }).type === "effect_acknowledgement",
      ),
    ).toBe(false);

    expect(paint).toBeDefined();
    paint!(0);
    await enabling;
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "effect_acknowledgement",
        value: {
          outcomes: [{ effect_id: 7, status: "completed", message: null }],
        },
      },
      undefined,
    );
  });
});
