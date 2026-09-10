import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertVmProfileAction,
  finishProfileCapture,
} from "../scripts/tauri-performance-vm-profile.mjs";

import {
  assertSecondaryActionStarted,
  assertSecondaryClickProtocolActions,
  capturePerformanceCheckpoint,
  performanceCheckpointBehaviorHash,
  freezePerformanceTrace,
  readPerformanceTrace,
  replayPerformanceTrace,
  runPerformanceTraceCapture,
  summarizeRuns,
  validatePerformanceTraceAction,
} from "../scripts/tauri-performance-trace.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Tauri performance trace schema 3", () => {
  it("preserves WebDriver undefined-to-null fields and the existing checkpoint hash", async () => {
    const raw = {
      transfer: { importKind: undefined, export: null },
      resources: { optional: undefined, values: [undefined, null] },
      coreProjection: { protocolActions: [] },
    };
    const expected = {
      transfer: { importKind: null, export: null },
      resources: { optional: null, values: [null, null] },
      coreProjection: { protocolActions: [] },
    };
    vi.stubGlobal("window", { __RUSTYERA_TEST__: { performanceCheckpoint: async () => raw } });
    const execute = vi.fn((callback, ...args) => callback(...args));
    const result = await capturePerformanceCheckpoint({ execute }, ["DAY"]);
    expect(result.value).toEqual(expected);
    expect(result.hash).toBe(performanceCheckpointBehaviorHash(expected));
    expect(execute).toHaveBeenCalledOnce();
  });
  it("transports the complete JSON-safe checkpoint and core projection as one string", async () => {
    const resource = {
      id: "18446744073709551615",
      sprites: Array.from({ length: 2000 }, (_, index) => ({ id: index, text: '门😀\u0000"\\' })),
      data: Array.from({ length: 4096 }, (_, index) => index % 256),
    };
    const raw = {
      phase: "running",
      output: ["玄关门前"],
      resources: resource,
      variables: { COUNTER: "9007199254740993" },
      coreProjection: {
        normalizedState: { resources: resource },
        setupMessages: [],
        protocolActions: [],
        protocolCursor: 42,
      },
    };
    const performanceCheckpoint = vi.fn(async () => raw);
    vi.stubGlobal("window", { __RUSTYERA_TEST__: { performanceCheckpoint } });
    const execute = vi.fn(async (callback, ...args) => {
      const wire = await callback(...args);
      expect(typeof wire).toBe("string");
      expect(JSON.parse(wire)).toEqual(raw);
      return wire;
    });
    const result = await capturePerformanceCheckpoint({ execute }, ["COUNTER"], 41);
    expect(performanceCheckpoint).toHaveBeenCalledExactlyOnceWith(["COUNTER"], 41);
    expect(result.value).toEqual(raw);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([{}, undefined, "{unfinished", "null", "[]"])(
    "rejects checkpoint transport %j instead of accepting a partial checkpoint",
    async (wire) => {
      const execute = vi.fn().mockResolvedValue(wire);
      await expect(capturePerformanceCheckpoint({ execute }, ["FLAG:0"])).rejects.toThrow(
        /JSON|object/,
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("propagates checkpoint rejection without a second observation or fallback", async () => {
    const error = new Error("checkpoint failure");
    const performanceCheckpoint = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("window", { __RUSTYERA_TEST__: { performanceCheckpoint } });
    const execute = vi.fn((callback, ...args) => callback(...args));
    await expect(capturePerformanceCheckpoint({ execute }, ["FLAG:0"])).rejects.toBe(error);
    expect(performanceCheckpoint).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "settles final observers before the last drain (timeout=%s)",
    async (timeout) => {
      const directory = await temporaryDirectory();
      const actions = join(directory, "actions.jsonl");
      const candidatePath = join(directory, "candidate.json");
      await writeFile(actions, `${JSON.stringify({ type: "finish" })}\n`);
      const order = [];
      const fixture = traceBrowser((state) => state, {
        onPending: async () => {
          order.push("pending");
          if (timeout) throw new Error("incomplete performance observations: timeout");
        },
        onTimings: async () => {
          order.push("drain");
        },
      });
      const result = runPerformanceTraceCapture(fixture.browser, {
        templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
        candidatePath,
        actionInboxPath: actions,
        projectDigest: "a".repeat(64),
      });
      if (timeout) await expect(result).rejects.toThrow("incomplete");
      else await result;
      expect(order).toEqual(["drain", "pending", "drain"]);
      const manifest = JSON.parse(await readFile(`${candidatePath}.timings/manifest.json`, "utf8"));
      expect(manifest.status).toBe(timeout ? "failed" : "complete");
    },
  );
  it.each([
    {
      name: "a changed wait",
      summary: { canInteract: true, fault: null, wait: { kind: "enter_key", waitId: 10 } },
    },
    {
      name: "a pending input",
      summary: { canInteract: false, fault: null, wait: { kind: "enter_key", waitId: 9 } },
    },
  ])("accepts $name as immediate native right-click progress", async ({ summary }) => {
    const browser = secondaryActionBrowser(summary);

    await expect(
      assertSecondaryActionStarted(
        browser,
        { type: "click", button: "right" },
        { value: { wait: { kind: "enter_key", waitId: 9 } } },
      ),
    ).resolves.toBeUndefined();
  });

  it("fails quickly when a native right click starts no input transition", async () => {
    const before = { value: { wait: { kind: "enter_key", waitId: 9 } } };
    const summary = {
      canInteract: true,
      fault: null,
      wait: { kind: "enter_key", waitId: 9 },
    };
    const browser = {
      execute: vi.fn(async () => summary),
      waitUntil: vi.fn(async (condition, options) => {
        expect(await condition()).toBe(false);
        throw new Error(options.timeoutMsg);
      }),
    };

    await expect(
      assertSecondaryActionStarted(browser, { type: "click", button: "right" }, before),
    ).rejects.toThrow(
      `right click produced no pending input or wait transition: ${JSON.stringify(summary)}`,
    );
    expect(browser.waitUntil).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 1_000,
      interval: 10,
      timeoutMsg: "right click produced no pending input or wait transition",
    });
  });

  it("does not accept a malformed right-click observation as progress", async () => {
    const browser = secondaryActionBrowser({ fault: null });

    await expect(
      assertSecondaryActionStarted(
        browser,
        { type: "click", button: "right" },
        { value: { wait: { kind: "enter_key", waitId: 9 } } },
      ),
    ).rejects.toThrow("right click produced no pending input or wait transition");
  });

  it("preserves runtime faults observed while confirming a native right click", async () => {
    const fault = { code: "runtime.test_fault", message: "failed" };
    const browser = secondaryActionBrowser({ canInteract: true, fault, wait: null });

    await expect(
      assertSecondaryActionStarted(
        browser,
        { type: "click", button: "right" },
        { value: { wait: { kind: "enter_key", waitId: 9 } } },
      ),
    ).rejects.toThrow(JSON.stringify(fault));
  });

  it("captures, freezes, signs, reads, and replays left and right clicks", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
    const directory = await temporaryDirectory();
    const template = resolve("tests/fixtures/snake-runtime-performance-trace.v3.json");
    const candidate = join(directory, "candidate.json");
    const actions = join(directory, "actions.jsonl");
    const frozen = join(directory, "trace.v3.json");
    const core = join(directory, "core-trace.v2.json");
    const commands = captureCommands();
    const observations = [];
    await writeFile(
      actions,
      `${commands.map((command) => JSON.stringify(command)).join("\n")}\n${JSON.stringify({ type: "finish" })}\n`,
    );

    const captureBrowser = traceBrowser();
    const captured = await runPerformanceTraceCapture(captureBrowser.browser, {
      templatePath: template,
      candidatePath: candidate,
      actionInboxPath: actions,
      projectDigest: "a".repeat(64),
      onObservation: (observation) => observations.push(observation),
    });
    expect(captured.schemaVersion).toBe(3);
    expect(Object.keys(captured.protocolResults)).toHaveLength(1);
    expect(JSON.stringify(captured.steps)).not.toContain('"result":');
    expect(JSON.stringify(captured)).not.toContain("large-resource-body");
    expect(JSON.stringify(captured).length).toBeLessThan(50_000);
    expect((await readFile(candidate)).byteLength).toBeLessThan(50_000);
    expect(captured.steps.every((step) => step.expect.checkpoint === undefined)).toBe(true);
    expect(captured.core.steps.every((step) => step.normalizedState === undefined)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("large-resource-body");
    expect(JSON.stringify(observations).length).toBeLessThan(50_000);
    expect(captureBrowser.elements.right.click).toHaveBeenCalledWith({ button: "right" });
    expect(captureBrowser.elements.left.click).toHaveBeenCalledWith();
    expect(observations.every((observation) => observation.inputElapsedMs >= 0)).toBe(true);

    const { trace } = await freezePerformanceTrace(candidate, frozen, core);
    expect(trace.traceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await readPerformanceTrace(frozen)).toEqual(trace);
    const coreTrace = JSON.parse(await readFile(core, "utf8"));
    expect(coreTrace.steps[0].action).toMatchObject({ message_skip: true });
    expect(coreTrace.steps[0].action).not.toHaveProperty("messageSkip");

    const invalidWait = structuredClone(captured);
    invalidWait.core.steps[0].expect.waitKind = "input";
    await expectFreezeFailure(invalidWait, directory, "invalid-wait", "invalid waitKind");
    const invalidTag = structuredClone(captured);
    invalidTag.core.steps[0].expect.outboundTags = ["bad"];
    await expectFreezeFailure(invalidTag, directory, "invalid-tag", "invalid outboundTags");
    const outOfOrder = structuredClone(captured);
    [outOfOrder.core.steps[0], outOfOrder.core.steps[1]] = [
      outOfOrder.core.steps[1],
      outOfOrder.core.steps[0],
    ];
    await expectFreezeFailure(outOfOrder, directory, "out-of-order", "out of Web action order");
    const duplicate = structuredClone(captured);
    duplicate.core.steps.splice(1, 0, {
      ...duplicate.core.steps[0],
      id: "duplicate-map",
      checkpoint: "duplicate-map",
    });
    await expectFreezeFailure(duplicate, directory, "duplicate-map", "not lossless");
    const unusedResult = structuredClone(captured);
    const unusedEntry = { kind: "service_response", result: { type: "ready", payload: [9] } };
    unusedResult.protocolResults[testDigest(unusedEntry)] = unusedEntry;
    await expectFreezeFailure(
      unusedResult,
      directory,
      "unused-result",
      "unreferenced protocol results",
    );

    const replayBrowser = traceBrowser();
    const replay = await replayPerformanceTrace(replayBrowser.browser, trace);
    expect(replayBrowser.elements.right.click).toHaveBeenCalledWith({ button: "right" });
    expect(replayBrowser.elements.left.click).toHaveBeenCalledWith();
    expect(replay.paths.every((path) => path.responseSamplesMs.length === 1)).toBe(true);
    const changedResourceBrowser = traceBrowser((state) => ({
      ...state,
      resources: { ...state.resources, changed: true },
    }));
    await expect(replayPerformanceTrace(changedResourceBrowser.browser, trace)).rejects.toThrow(
      "scenario signature mismatch",
    );

    const tampered = JSON.parse(await readFile(frozen, "utf8"));
    tampered.steps[0].action.button = "left";
    await writeFile(join(directory, "tampered.json"), JSON.stringify(tampered));
    await expect(readPerformanceTrace(join(directory, "tampered.json"))).rejects.toThrow(
      "trace digest mismatch",
    );
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    "isolates capture setup and diagnostic timing (acceptance=%s, background=%s)",
    async (acceptanceTiming, background) => {
      vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", background ? "1" : "0");
      let now = 0;
      const boundaryOrder = [];
      let profileOpen = false;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const hooks = {
        onTransport: () => {
          now += 10_000;
        },
        onTimings: () => {
          expect(profileOpen).toBe(false);
          now += 300;
        },
        onPrepare: () => {
          now += 500;
        },
        onCheckpoint: () => {
          expect(profileOpen).toBe(false);
          boundaryOrder.push("checkpoint");
          now += 1_000;
        },
        onStable: () => {
          boundaryOrder.push("stable");
          now += 7;
        },
      };
      const directory = await temporaryDirectory();
      const candidate = join(directory, "timing-candidate.json");
      const frozen = join(directory, "timing-trace.json");
      const core = join(directory, "timing-core.json");
      const actions = join(directory, "timing-actions.jsonl");
      await writeFile(
        actions,
        `${captureCommands()
          .concat({ type: "finish" })
          .map((command) => JSON.stringify(command))
          .join("\n")}\n`,
      );
      const captureBrowser = traceBrowser((state) => state, hooks);
      const observations = [];
      await runPerformanceTraceCapture(captureBrowser.browser, {
        acceptanceTiming,
        templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
        candidatePath: candidate,
        actionInboxPath: actions,
        projectDigest: "a".repeat(64),
        onObservation: (observation) => observations.push(observation),
        beforeTimedAction: () => {
          profileOpen = true;
          boundaryOrder.push("begin-profile");
          now += 200;
        },
        afterTimedAction: () => {
          profileOpen = false;
          boundaryOrder.push("end-profile");
          now += 2_000;
        },
      });
      expect(boundaryOrder).toEqual(
        Array.from({ length: 4 }, () => [
          "checkpoint",
          "begin-profile",
          "stable",
          "end-profile",
          "checkpoint",
        ]).flat(),
      );
      expect(observations.map((observation) => observation.inputElapsedMs)).toEqual([7, 7, 7, 7]);
      expect(observations.every((row) => row.acceptanceTiming === acceptanceTiming)).toBe(true);
      expect(
        observations.every(
          (row) =>
            row.timingBasis ===
            (acceptanceTiming
              ? background
                ? "dom-action-to-stable-observation"
                : "action-to-stable-observation"
              : "diagnostic-only"),
        ),
      ).toBe(true);
      const timing = JSON.parse(
        await readFile(join(`${candidate}.timings`, "0002.summary.json"), "utf8"),
      );
      expect(timing.boundary.acceptanceTiming).toBe(acceptanceTiming);

      const { trace } = await freezePerformanceTrace(candidate, frozen, core);
      const replayBrowser = traceBrowser((state) => state, hooks);
      const replay = await replayPerformanceTrace(replayBrowser.browser, trace);
      expect(replay.paths.flatMap((path) => path.responseSamplesMs)).toEqual([7, 7, 7, 7]);
      const summary = summarizeRuns([replay]);
      const basis = background
        ? "dom-action-to-stable-observation"
        : "action-to-stable-observation";
      expect(summary.responseTimingBasis).toBe(basis);
      const otherBasis = {
        ...replay,
        paths: replay.paths.map((path) => ({
          ...path,
          responseTimingBasis: background
            ? "action-to-stable-observation"
            : "dom-action-to-stable-observation",
        })),
      };
      expect(() => summarizeRuns([replay, otherBasis])).toThrow("cannot mix action clock bases");
      expect(summarizeRuns([replay, { ...otherBasis, acceptanceTiming: false }])).toEqual(summary);
      const legacy = {
        ...replay,
        paths: replay.paths.map((path) => {
          const entry = { ...path };
          delete entry.responseTimingBasis;
          return entry;
        }),
      };
      if (background)
        expect(() => summarizeRuns([legacy, replay])).toThrow("cannot mix action clock bases");
      else expect(summarizeRuns([legacy])).toEqual(summary);
      expect(summarizeRuns([{ ...replay, acceptanceTiming: false }, replay])).toEqual(summary);
      expect(Object.values(summary.byPath).map((sample) => sample.p50)).toEqual([7, 7, 7, 7]);
      vi.stubEnv("RUSTYERA_TAURI_PERF_HEAVY_DIAGNOSTICS", "1");
      const diagnosticBrowser = traceBrowser((state) => state, hooks);
      const diagnostic = await replayPerformanceTrace(diagnosticBrowser.browser, trace);
      expect(diagnostic.paths.flatMap((path) => path.responseSamplesMs)).toEqual([]);
      expect(diagnostic.paths.flatMap((path) => path.diagnosticResponseSamples)).toEqual(
        Array.from({ length: 4 }, () => ({
          elapsedMs: 7,
          timingBasis: "diagnostic-heavy-dom",
          step: 0,
        })),
      );
      expect(Object.values(summary.harnessByPath).every((sample) => sample.p50 > 1_000)).toBe(true);
    },
  );

  it("keeps background checkpoint-change actions on the diagnostic checkpoint and stable path", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "1");
    const directory = await temporaryDirectory();
    const actions = join(directory, "checkpoint-actions.jsonl");
    const candidate = join(directory, "checkpoint-candidate.json");
    const commands = captureCommands().map((command) => ({
      ...command,
      settle: "checkpoint_change",
    }));
    await writeFile(
      actions,
      commands.concat({ type: "finish" }).map(JSON.stringify).join("\n") + "\n",
    );
    const stable = vi.fn();
    const fixture = traceBrowser((state) => state, { onStable: stable });
    const observations = [];
    await runPerformanceTraceCapture(fixture.browser, {
      templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
      candidatePath: candidate,
      actionInboxPath: actions,
      projectDigest: "a".repeat(64),
      onObservation: (row) => observations.push(row),
    });
    expect(stable).toHaveBeenCalledTimes(4);
    expect(fixture.checkpointCalls()).toBe(12);
    expect(observations.map((row) => row.timingBasis)).toEqual(
      Array(4).fill("diagnostic-checkpoint-change"),
    );
    expect(
      fixture.browser.execute.mock.calls.some(([operation]) => typeof operation === "string"),
    ).toBe(false);
    const { trace } = await freezePerformanceTrace(
      candidate,
      join(directory, "checkpoint-frozen.json"),
    );
    const replay = await replayPerformanceTrace(traceBrowser().browser, trace);
    expect(replay.paths.flatMap((path) => path.responseSamplesMs)).toEqual([]);
    expect(replay.paths.flatMap((path) => path.diagnosticResponseSamples)).toHaveLength(4);
  });

  it("does not finish an action before the stable-observation gate resolves", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
    const directory = await temporaryDirectory();
    const actions = join(directory, "stable-actions.jsonl");
    await writeFile(
      actions,
      `${JSON.stringify(captureCommands()[0])}\n${JSON.stringify({ type: "finish" })}\n`,
    );
    let releaseStable;
    const stable = new Promise((resolve) => {
      releaseStable = resolve;
    });
    const fixture = traceBrowser((state) => state, { onStable: () => stable });
    let completed = false;
    const afterTimedAction = vi.fn();
    const capture = runPerformanceTraceCapture(fixture.browser, {
      templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
      candidatePath: join(directory, "stable-candidate.json"),
      actionInboxPath: actions,
      projectDigest: "a".repeat(64),
      afterTimedAction,
    }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(fixture.elements.right.click).toHaveBeenCalled());
    expect(completed).toBe(false);
    expect(afterTimedAction).not.toHaveBeenCalled();
    releaseStable();
    await capture;
    expect(completed).toBe(true);
    expect(afterTimedAction).toHaveBeenCalledOnce();
  });

  it.each(["checkpoint_change", "stable", "end"])(
    "closes diagnostic windows on %s failure without a second checkpoint",
    async (failureStage) => {
      vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
      const directory = await temporaryDirectory();
      const actions = join(directory, "profile-failure-actions.jsonl");
      const command = captureCommands()[0];
      if (failureStage === "checkpoint_change") command.settle = "checkpoint_change";
      await writeFile(
        actions,
        JSON.stringify(command) + "\n" + JSON.stringify({ type: "finish" }) + "\n",
      );
      const error = new Error(failureStage);
      const checkpoint = vi.fn();
      const begin = vi.fn();
      const end = vi.fn(() => {
        if (failureStage === "end") throw error;
      });
      const close = vi.fn();
      const fixture = traceBrowser((state) => state, {
        onCheckpoint: checkpoint,
        onStable: () => {
          if (failureStage === "stable") throw error;
        },
      });
      let failure;
      try {
        await runPerformanceTraceCapture(fixture.browser, {
          acceptanceTiming: false,
          templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
          candidatePath: join(directory, "profile-failure-candidate.json"),
          actionInboxPath: actions,
          projectDigest: "a".repeat(64),
          beforeTimedAction: ({ settle }) => {
            assertVmProfileAction(settle);
            begin();
          },
          afterTimedAction: end,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      await expect(finishProfileCapture([close], { error: failure })).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledOnce();
      if (failureStage === "checkpoint_change") {
        expect(begin).not.toHaveBeenCalled();
        expect(fixture.elements.right.click).not.toHaveBeenCalled();
      } else expect(begin).toHaveBeenCalledOnce();
      if (failureStage === "end") expect(end).toHaveBeenCalledOnce();
      else expect(end).not.toHaveBeenCalled();
    },
  );

  it("compacts inline and post-observation Core mappings through one path", async () => {
    vi.stubEnv("RUSTYERA_TEST_BACKGROUND_DOM", "0");
    const directory = await temporaryDirectory();
    const actions = join(directory, "manual-actions.jsonl");
    const commands = captureCommands();
    commands[0].coreSteps = [
      {
        id: "inline",
        checkpoint: "inline",
        normalizedState: normalizedState(0),
        action: { kind: "input", intent: { kind: "none" }, messageSkip: true },
      },
    ];
    commands[1].coreSteps = [];
    await writeFile(
      actions,
      `${[
        commands[0],
        commands[1],
        {
          type: "core_steps",
          sourceWebStep: 1,
          coreSteps: [
            {
              id: "post",
              checkpoint: "post",
              normalizedState: normalizedState(1),
              action: {
                kind: "input",
                intent: { kind: "integer", value: 1 },
                messageSkip: false,
              },
            },
          ],
        },
        { type: "finish" },
      ]
        .map((command) => JSON.stringify(command))
        .join("\n")}\n`,
    );
    const observations = [];
    const captured = await runPerformanceTraceCapture(traceBrowser().browser, {
      templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
      candidatePath: join(directory, "manual-candidate.json"),
      actionInboxPath: actions,
      projectDigest: "a".repeat(64),
      onObservation: (observation) => observations.push(observation),
    });
    expect(captured.core.steps.map((step) => step.sourceWebStep)).toEqual([0, 1, undefined]);
    expect(JSON.stringify(captured)).not.toContain("large-resource-body");
    expect(JSON.stringify(observations)).not.toContain("large-resource-body");
  });

  it("rejects invalid normalized Core state before discarding its body", async () => {
    const directory = await temporaryDirectory();
    const actions = join(directory, "invalid-state-actions.jsonl");
    await writeFile(actions, `${JSON.stringify(captureCommands()[0])}\n`);
    const fixture = traceBrowser((state) => ({ ...state, wait: { kind: "input" } }));
    await expect(
      runPerformanceTraceCapture(fixture.browser, {
        templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
        candidatePath: join(directory, "invalid-state-candidate.json"),
        actionInboxPath: actions,
        projectDigest: "a".repeat(64),
      }),
    ).rejects.toThrow("invalid wait kind");
  });

  it("does not allow a manual mapping to replace the final observed Core checkpoint", async () => {
    const directory = await temporaryDirectory();
    const actions = join(directory, "manual-none-actions.jsonl");
    const command = captureCommands()[0];
    command.coreSteps = [
      {
        id: "manual-final",
        checkpoint: "manual-final",
        normalizedState: normalizedState(0),
        action: { kind: "none" },
      },
    ];
    await writeFile(actions, `${JSON.stringify(command)}\n`);
    await expect(
      runPerformanceTraceCapture(traceBrowser().browser, {
        templatePath: resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"),
        candidatePath: join(directory, "manual-none-candidate.json"),
        actionInboxPath: actions,
        projectDigest: "a".repeat(64),
      }),
    ).rejects.toThrow("cannot supply the final none action");
  });

  it.each([null, "middle", "RIGHT"])(
    "rejects an invalid click button %j before capture input",
    async (button) => {
      const directory = await temporaryDirectory();
      const template = resolve("tests/fixtures/snake-runtime-performance-trace.v3.json");
      const actions = join(directory, "actions.jsonl");
      await writeFile(
        actions,
        `${JSON.stringify({
          type: "action",
          path: "loading",
          action: {
            type: "click",
            selector: "#right",
            expectedText: "Skip",
            semanticInput: "",
            button,
          },
          watches: ["TEST"],
          evidence: {},
        })}\n`,
      );
      const fixture = traceBrowser();
      await expect(
        runPerformanceTraceCapture(fixture.browser, {
          templatePath: template,
          candidatePath: join(directory, "candidate.json"),
          actionInboxPath: actions,
          projectDigest: "a".repeat(64),
        }),
      ).rejects.toThrow("unsupported button");
      expect(fixture.checkpointCalls()).toBe(0);
      expect(fixture.browser.$).not.toHaveBeenCalled();
    },
  );

  it("keeps an omitted button as the schema-3 left-click compatibility form", () => {
    expect(() =>
      validatePerformanceTraceAction({
        type: "click",
        selector: "#left",
        expectedText: "Left",
        semanticInput: "1",
      }),
    ).not.toThrow();
  });

  it("requires a secondary click to map to exactly one message-skip input", () => {
    const action = {
      type: "click",
      selector: "#right",
      expectedText: "Skip",
      semanticInput: "",
      button: "right",
    };
    expect(() =>
      assertSecondaryClickProtocolActions(action, [
        { kind: "input", intent: { kind: "none" }, messageSkip: false },
      ]),
    ).toThrow("messageSkip=true");
    expect(() =>
      assertSecondaryClickProtocolActions(action, [
        { kind: "input", intent: { kind: "none" }, messageSkip: true },
        { kind: "input", intent: { kind: "none" }, messageSkip: true },
      ]),
    ).toThrow("exactly one Core input");
  });

  it("rejects schema 1 instead of silently changing its click semantics", async () => {
    const directory = await temporaryDirectory();
    const legacy = JSON.parse(
      await readFile(resolve("tests/fixtures/snake-runtime-performance-trace.v3.json"), "utf8"),
    );
    legacy.schemaVersion = 1;
    legacy.captureRequired = false;
    legacy.projectDigest = "a".repeat(64);
    const path = join(directory, "legacy.json");
    await writeFile(path, JSON.stringify(legacy));
    await expect(readPerformanceTrace(path)).rejects.toThrow(
      "unsupported performance trace schema",
    );
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rustyera-performance-trace-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectFreezeFailure(candidate, directory, name, message) {
  const candidatePath = join(directory, `${name}.candidate.json`);
  await writeFile(candidatePath, JSON.stringify(candidate));
  await expect(
    freezePerformanceTrace(
      candidatePath,
      join(directory, `${name}.trace.json`),
      join(directory, `${name}.core.json`),
    ),
  ).rejects.toThrow(message);
}

function captureCommands() {
  const evidence = {
    loading: ["title", "newGame", "qol", "sql", "map", "privateRoom", "day1"],
    "steady-runtime": ["dailyLoop", "longOutput", "dynamicCall", "formatting", "stringWork"],
    "map-nf-sql": ["mapRoundtrip", "hover", "click", "nf", "scene", "canvas", "sprite", "sqlPath"],
    "save-load": ["ordinarySave", "ordinaryLoad", "stableReturn"],
  };
  const actions = [
    {
      path: "loading",
      action: {
        type: "click",
        selector: "#right",
        expectedText: "Skip",
        semanticInput: "",
        button: "right",
      },
    },
    { path: "steady-runtime", action: { type: "input", value: 1 } },
    {
      path: "map-nf-sql",
      action: { type: "click", selector: "#left", expectedText: "Left", semanticInput: "1" },
    },
    { path: "save-load", action: { type: "input", value: 2 } },
  ];
  return actions.map(({ path, action }) => ({
    type: "action",
    path,
    action,
    watches: ["TEST"],
    evidence: Object.fromEntries(evidence[path].map((key) => [key, true])),
  }));
}

function traceBrowser(normalize = (state) => state, hooks = {}) {
  let stateIndex = 0;
  let checkpointCallCount = 0;
  const protocolActions = [
    { kind: "input", intent: { kind: "none" }, messageSkip: true },
    { kind: "input", intent: { kind: "integer", value: 1 }, messageSkip: false },
    {
      kind: "service_response",
      service: { kind: "sql", operation: "rustyera.sql" },
      result: { payload: [1, 2, 3] },
    },
    {
      kind: "service_response",
      service: { kind: "sql", operation: "rustyera.sql" },
      result: { payload: [1, 2, 3] },
    },
  ];
  const checkpoints = Array.from({ length: 5 }, (_, index) => checkpoint(index));
  const advance = vi.fn(() => {
    stateIndex += 1;
  });
  const elements = {
    right: element("Skip", advance),
    left: element("Left", advance),
    prompt: {
      isDisplayed: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      setValue: vi.fn(),
    },
    submit: {
      isDisplayed: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      click: advance,
    },
  };
  const browser = {
    execute: vi.fn(async (operation, _watches, protocolCursor) => {
      const source = operation.toString();
      if (typeof operation === "string" && source.includes("measureBackgroundDomAction")) {
        await hooks.onTransport?.();
        advance();
        const startedAt = performance.now();
        await hooks.onStable?.();
        const elapsedMs = performance.now() - startedAt;
        await hooks.onTransport?.();
        return { elapsedMs, inputEvidence: { mode: "background-dom", input: protocolCursor } };
      }
      if (operation.name === "applyBackgroundDomAction") {
        if (protocolCursor !== "value") advance();
        return { mode: "background-dom", input: protocolCursor };
      }
      if (source.includes("waitForStableObservation")) {
        await hooks.onStable?.();
        return true;
      }
      if (source.includes("waitForPendingPerformanceObservations")) return hooks.onPending?.();
      if (source.includes("takePerformanceAudit")) {
        await hooks.onTimings?.();
        return JSON.stringify({
          frontend: {
            schemaVersion: 2,
            epoch: 1,
            nextSequence: 0,
            nextLongTaskSequence: 0,
            timingSamplesDropped: 0,
            longTasksDropped: 0,
            remainingSamples: 0,
            remainingLongTasks: 0,
            timings: [],
            longTasks: [],
          },
          native: {
            schemaVersion: 2,
            epoch: 1,
            nextSequence: 0,
            dropped: 0,
            remainingSamples: 0,
            pumps: [],
            coreClient: {
              capabilities: {
                rich_text: true,
                html: true,
                graphics: true,
                input_modalities: ["mouse"],
                storage: { revisions: true },
              },
            },
            setupMessages: [],
          },
        });
      }
      if (source.includes("performanceCheckpoint")) {
        await hooks.onCheckpoint?.();
        checkpointCallCount += 1;
        const checkpoint = structuredClone(checkpoints[stateIndex]);
        checkpoint.coreProjection.protocolActions =
          protocolCursor == null ? [] : protocolActions.slice(protocolCursor, stateIndex);
        checkpoint.coreProjection.protocolCursor = stateIndex;
        return JSON.stringify(checkpoint);
      }
      if (source.includes("performanceProgress"))
        return { canInteract: true, fault: null, wait: checkpoints[stateIndex].wait };
      throw new Error(`unexpected browser operation: ${source}`);
    }),
    $: vi.fn(async (selector) => {
      await hooks.onPrepare?.();
      if (selector === "#right") return elements.right;
      if (selector === "#left") return elements.left;
      if (selector === ".prompt-bar input") return elements.prompt;
      if (selector === ".prompt-bar button[type=submit]") return elements.submit;
      throw new Error(`unexpected selector ${selector}`);
    }),
    waitUntil: vi.fn(async (condition) => {
      expect(await condition()).toBe(true);
    }),
  };
  return { browser, elements, checkpointCalls: () => checkpointCallCount };

  function checkpoint(index) {
    const variables = { TEST: index };
    return {
      wait: { kind: "integer_value", generation: index, waitId: index },
      variables,
      service: null,
      storage: null,
      transfer: null,
      coreProjection: {
        setupMessages: [],
        protocolActions: [],
        protocolCursor: index,
        normalizedState: normalize(normalizedState(index)),
      },
    };
  }
}

function secondaryActionBrowser(summary) {
  return {
    execute: vi.fn(async () => summary),
    waitUntil: vi.fn(async (condition, options) => {
      if (await condition()) return;
      throw new Error(options.timeoutMsg);
    }),
  };
}

function normalizedState(index) {
  return {
    lines: [],
    otherOutboundTags: [],
    phase: "waiting_input",
    resources: {
      sprites: [{ marker: "large-resource-body", data: "x".repeat(100_000) }],
      canvases: [],
    },
    scene: { revision: 0, layers: [] },
    services: [],
    storage: [],
    variables: { TEST: index },
    wait: { kind: "integer_value" },
  };
}

function element(text, advance) {
  return {
    isExisting: vi.fn().mockResolvedValue(true),
    getText: vi.fn().mockResolvedValue(text),
    click: vi.fn(advance),
  };
}

function testDigest(value) {
  const sorted = (item) => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sorted(item[key])]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
