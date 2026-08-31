#!/usr/bin/env node
/* global window */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  ReferenceProcess,
  TraceWriter,
  compareObservations,
  goalStatus,
  injectInGameSaveFlow,
  injectInteractionAssistFlow,
  installRemoteFileSystem,
  isolatedProject,
  loadScenario,
  observationFromSnapshot,
  publishCrossHostArtifacts,
  runAction,
  shellWords,
  waitForAutomaticWaitChange,
  waitForRuntimeObservation,
} from "./web-test-lib.mjs";
import { finalizeBrowserGameRun } from "./web-test-lifecycle.mjs";
import { startCompleteSnapshotMonitor } from "./tauri-test-support.mjs";
import { createLoopbackViteServer, viteServerPort } from "./vite-test-server.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const OBSERVATION_SLICE_MS = 5_000;
const OBSERVABLE_STEP_ACTION_TYPES = new Set([
  "input",
  "click",
  "touch_gesture",
  "dblclick",
  "press",
  "drain_void_waits",
  "advance_intermediate_waits_until",
  "advance_enter_waits_until",
  "wait_timed_input_change",
]);

function isObservableStepAction(type) {
  return OBSERVABLE_STEP_ACTION_TYPES.has(type);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["run", "serve"].includes(command))
    throw new Error("usage: web-test <run|serve> --scenario FILE");
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    values[key.slice(2).replaceAll("-", "_")] = rest[++index];
  }
  if (!values.scenario) throw new Error("--scenario is required");
  return values;
}

async function execute(args) {
  const scenario = await loadScenario(args.scenario, args.project, args.state);
  if (args.project_file) scenario.project_file = path.resolve(args.project_file);
  if (scenario.requires_project_file === true && !args.project_file) {
    throw new Error(`${scenario.path} requires an explicit --project-file artifact`);
  }
  await access(path.join(repository, "public/wasm/era_web_wasm.js"));
  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${process.pid}`;
  const tracePath = path.resolve(
    args.trace ??
      path.join(
        repository,
        ".rustyera/test-runs",
        `${path.basename(scenario.path, ".json")}-${runId}`,
        "trace.ndjson",
      ),
  );
  await mkdir(path.dirname(tracePath), { recursive: true });
  const trace = new TraceWriter(tracePath);
  const webProject = await isolatedProject(scenario.project, {
    compiledCache:
      scenario.compiled_cache === true || Boolean(process.env.RUSTYERA_TEST_COMPILED_CACHE_INPUT),
    compiledCacheInput: process.env.RUSTYERA_TEST_COMPILED_CACHE_INPUT,
    sourceIndexInput: process.env.RUSTYERA_TEST_SOURCE_INDEX_INPUT,
    cleanSaves: scenario.clean_saves === true,
  });
  if (scenario.prepare_in_game_save) {
    const entry = path.join(webProject.project, "erb", "oracle.erb");
    await writeFile(entry, injectInGameSaveFlow(await readFile(entry, "utf8")));
  }
  if (scenario.prepare_interaction_assist) {
    const entry = path.join(webProject.project, "erb", "oracle.erb");
    await writeFile(entry, injectInteractionAssistFlow(await readFile(entry, "utf8")));
  }
  let referenceProject;
  let reference;
  let browser;
  let server;
  let page;
  let agentInput;
  let snapshotMonitor;
  let snapshotMonitorError;
  const consoleMessages = [];
  let previousOutput = [];
  let referenceObservation;
  let steps = 0;
  let compiledCacheSaved = false;
  const deadline = Date.now() + scenario.limits.timeout_seconds * 1000;
  const outcome = (status, exitCode, extra = {}) => ({
    exitCode,
    result: { status, seed: scenario.seed, trace: tracePath, ...extra },
  });
  const captureFailureArtifacts = async () => {
    if (!page) return;
    const artifacts = path.dirname(tracePath);
    await page
      .screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true })
      .catch(() => {});
    const html = await page.content().catch(() => undefined);
    if (html !== undefined)
      await writeFile(path.join(artifacts, "failure.html"), html).catch(() => {});
    await writeFile(
      path.join(artifacts, "browser-console.json"),
      JSON.stringify(consoleMessages, null, 2),
    ).catch(() => {});
  };
  const fail = async (status, exitCode, extra = {}) => {
    await captureFailureArtifacts();
    return outcome(status, exitCode, extra);
  };
  const classifyError = (error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const assertionFailure = message.includes("assertion failed at");
    return outcome(
      assertionFailure ? "assertion_failure" : "infrastructure_failure",
      assertionFailure ? 1 : 3,
    );
  };
  let completedOutcome;
  let runError;
  try {
    completedOutcome = await runScenario();
  } catch (error) {
    runError = error;
    await captureFailureArtifacts();
  }

  return finalizeBrowserGameRun({
    outcome: completedOutcome,
    runError,
    monitor: snapshotMonitor,
    monitorError: () => snapshotMonitorError,
    cleanups: [
      () => agentInput?.close(),
      () => reference?.close(),
      () => referenceProject?.close(),
      () =>
        publishCrossHostArtifacts({
          source: scenario.project,
          isolated: webProject.project,
          cacheInput: process.env.RUSTYERA_TEST_COMPILED_CACHE_INPUT,
          cacheOutput: process.env.RUSTYERA_TEST_COMPILED_CACHE_OUTPUT,
          sourceIndexInput: process.env.RUSTYERA_TEST_SOURCE_INDEX_INPUT,
          sourceIndexOutput: process.env.RUSTYERA_TEST_SOURCE_INDEX_OUTPUT,
          projectOutput: process.env.RUSTYERA_TEST_PROJECT_OUTPUT,
          succeeded: completedOutcome?.exitCode === 0 && runError == null,
          cacheSaved: compiledCacheSaved,
        }),
      () => browser?.close(),
      () => server?.close(),
      () => webProject.close(),
    ],
    trace,
    classifyError,
  });

  async function runScenario() {
    process.env.VITE_RUSTYERA_TEST = "1";
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repository, ".playwright-browsers");
    const { chromium } = await import("@playwright/test");
    server = await createLoopbackViteServer({
      root: repository,
      mode: "test",
      define: {
        "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1"),
        "import.meta.env.VITE_RUSTYERA_TEST_TRUST_METADATA": JSON.stringify(
          process.env.VITE_RUSTYERA_TEST_TRUST_METADATA ?? "0",
        ),
      },
      plugins: [
        {
          name: "rustyera-test-wasm",
          configureServer(viteServer) {
            viteServer.middlewares.use((request, response, next) => {
              if (request.url === "/__rustyera_test_state" && scenario.start.path) {
                response.setHeader("Content-Type", "application/octet-stream");
                const stream = createReadStream(scenario.start.path);
                stream.on("error", (error) => {
                  if (!response.headersSent)
                    response.statusCode = error.code === "ENOENT" ? 404 : 500;
                  response.end();
                });
                stream.pipe(response);
                return;
              }
              if (request.url?.startsWith("/__rustyera_test_file?")) {
                const relative = new URL(request.url, "http://localhost").searchParams.get("path");
                const target = path.resolve(webProject.project, relative ?? ".");
                if (
                  !relative ||
                  (target !== webProject.project &&
                    !target.startsWith(`${webProject.project}${path.sep}`))
                ) {
                  response.statusCode = 403;
                  response.end();
                  return;
                }
                response.setHeader("Content-Type", "application/octet-stream");
                const stream = createReadStream(target);
                stream.on("error", (error) => {
                  if (!response.headersSent)
                    response.statusCode = error.code === "ENOENT" ? 404 : 500;
                  response.end();
                });
                stream.pipe(response);
                return;
              }
              next();
            });
          },
        },
      ],
      server: { watch: { ignored: ["**/.rustyera/**"] } },
    });
    const port = viteServerPort(server);
    const executablePath = args.chromium_executable
      ? path.resolve(args.chromium_executable)
      : undefined;
    if (executablePath) await access(executablePath);
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: scenario.viewport,
      hasTouch: scenario.has_touch,
      reducedMotion: "reduce",
      userAgent: args.user_agent,
    });
    await context.grantPermissions(["local-fonts"], {
      origin: `http://127.0.0.1:${port}`,
    });
    page = await context.newPage();
    page.on("console", (message) =>
      consoleMessages.push({ type: message.type(), text: message.text() }),
    );
    await installRemoteFileSystem(page, webProject.project);
    if (scenario.project_file) {
      await page.addInitScript(() => {
        Object.defineProperty(window, "showOpenFilePicker", {
          configurable: true,
          value: undefined,
        });
      });
    }
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => window.__RUSTYERA_TEST__ != null);
    snapshotMonitor = startCompleteSnapshotMonitor(
      { execute: (script) => page.evaluate(script) },
      {
        deadline,
        describeDeadline: () => "browser game test exceeded its scenario deadline",
        eventType: "browser-game-snapshot",
        label: "Chromium game test",
        outputEvent: (event) => trace.emit(event),
      },
    );
    void snapshotMonitor.failure.catch(async (error) => {
      snapshotMonitorError = error;
      agentInput?.close();
      await page?.close().catch(() => undefined);
    });
    await page.evaluate(
      async ({ start, seed, clock, stateUrl }) => {
        const response = stateUrl ? await fetch(stateUrl) : undefined;
        if (response && !response.ok)
          throw new Error(`test state fetch failed with HTTP ${response.status}`);
        const stateBytes = response ? new Uint8Array(await response.arrayBuffer()) : undefined;
        window.__RUSTYERA_TEST__.configure({
          start: {
            type: start.type,
            seed,
            bytes: stateBytes,
          },
          clock,
        });
      },
      {
        start: scenario.start,
        seed: scenario.seed,
        clock: scenario.clock,
        stateUrl: scenario.start.path ? "/__rustyera_test_state" : undefined,
      },
    );
    for (const action of scenario.before_open_actions ?? []) await runAction(page, action);
    if (scenario.project_file) {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "从项目文件启动…", exact: true }).click();
      await (await chooser).setFiles(scenario.project_file);
    } else {
      await page.getByRole("button", { name: "打开 Era 项目…", exact: true }).click();
    }

    if (scenario.comparison.reference && scenario.start.type !== "vm_snapshot") {
      const command = shellWords(args.reference_command ?? scenario.comparison.reference_command);
      if (!command.length) throw new Error("reference comparison requires --reference-command");
      referenceProject = await isolatedProject(scenario.project);
      reference = new ReferenceProcess(
        command,
        shellWords(args.reference_path_command ?? scenario.comparison.reference_path_command),
        Number(scenario.comparison.timeout_seconds ?? 30) * 1000,
      );
      referenceObservation = await reference.start({
        ...scenario,
        project: referenceProject.project,
      });
    }

    async function waitForObservation() {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("scenario timeout exhausted");
        try {
          return await Promise.race([
            waitForRuntimeObservation(page, Math.min(OBSERVATION_SLICE_MS, remaining)),
            snapshotMonitor.failure,
          ]);
        } catch (error) {
          if (snapshotMonitorError) throw snapshotMonitorError;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("等待稳定输入状态超时")) throw error;
        }
      }
    }

    async function observe(automaticEnter = true) {
      for (
        let automaticWaits = 0;
        automaticWaits <= scenario.limits.max_steps;
        automaticWaits += 1
      ) {
        if (Date.now() > deadline) throw new Error("scenario timeout exhausted");
        const snapshot = await waitForObservation();
        const rust = observationFromSnapshot(snapshot, previousOutput);
        previousOutput = rust.output;
        if (scenario.watches.length)
          rust.watches = await page.evaluate(
            (watches) => window.__RUSTYERA_TEST__.inspect(watches),
            scenario.watches,
          );
        const event = {
          type: "observation",
          step: steps,
          seed: scenario.seed,
          rust,
          goal: goalStatus(rust, scenario.goal),
        };
        if (referenceObservation) {
          event.reference = referenceObservation;
          event.comparison = compareObservations(rust, referenceObservation, scenario.comparison);
        }
        trace.emit(event);
        if (
          event.goal.satisfied ||
          event.comparison?.equal === false ||
          rust.wait?.kind !== "enter_key" ||
          !automaticEnter
        )
          return event;
        if (rust.wait.deadline_ns != null) {
          await waitForAutomaticWaitChange(page, rust.wait.wait_id);
          continue;
        }
        trace.emit({
          type: "action",
          step: steps,
          source: "automatic_enter",
          action: { type: "input", value: "" },
        });
        await runAction(page, { type: "input", value: "", keyboard_submit: true });
        if (reference) referenceObservation = await reference.step("", scenario.watches);
      }
      throw new Error("automatic wait budget exhausted");
    }

    async function act(action, source) {
      if (steps >= scenario.limits.max_steps) throw new Error("step budget exhausted");
      trace.emit({ type: "action", step: steps + 1, source, action });
      const result = await runAction(page, action);
      if (action.type === "wait_compiled_cache_saved") compiledCacheSaved = true;
      if (reference && action.advances_game && result.semanticInput == null)
        throw new Error(`${action.type} that advances a compared game must declare semantic_input`);
      if (reference && result.semanticInput != null)
        referenceObservation = await reference.step(String(result.semanticInput), scenario.watches);
      if (isObservableStepAction(action.type)) steps += 1;
      return result;
    }

    async function saveCheckpoint(configuredPath) {
      const target = path.resolve(
        configuredPath
          ? path.resolve(path.dirname(scenario.path), configuredPath)
          : path.join(path.dirname(tracePath), "checkpoint.snapshot"),
      );
      await page.waitForFunction(
        () => window.__RUSTYERA_TEST__.snapshot().transfer?.export == null,
        undefined,
        { timeout: Math.max(1, deadline - Date.now()) },
      );
      await page.evaluate(() => window.__RUSTYERA_TEST__.exportSnapshot());
      const download = await page.evaluate(() => window.__RUSTYERA_TEST__.takeDownload(30_000));
      await writeFile(target, new Uint8Array(download.bytes));
      trace.emit({ type: "checkpoint", path: target });
    }

    trace.emit({
      type: "start",
      scenario: scenario.path,
      project: scenario.project,
      projectFile: scenario.project_file,
      mode: scenario.mode,
      start: scenario.start.type,
      seed: scenario.seed,
      clock: scenario.clock ?? "2026-01-01T00:00:00Z",
      userAgent: args.user_agent,
      trace: tracePath,
    });
    let current = await observe();
    if (scenario.project_file) {
      const exactCacheHit = current.rust.frontend.logs.some((entry) =>
        String(entry.message).includes("runtime.compiled_cache_hit"),
      );
      if (current.rust.frontend.startupTelemetry?.cacheHit !== true || !exactCacheHit) {
        throw new Error(
          `packaged project did not use its exact compiled cache: ${JSON.stringify({ startupTelemetry: current.rust.frontend.startupTelemetry, exactCacheHit })}`,
        );
      }
    }
    if (
      process.env.RUSTYERA_TEST_COMPILED_CACHE_INPUT &&
      current.rust.frontend.startupTelemetry?.cacheHit !== true
    ) {
      throw new Error(
        `cross-host compiled cache was not accepted: ${JSON.stringify(current.rust.frontend.startupTelemetry)}`,
      );
    }
    if (
      process.env.RUSTYERA_TEST_SOURCE_INDEX_INPUT &&
      ((current.rust.frontend.startupTelemetry?.sourceIndex?.reusedFiles ?? 0) < 1 ||
        (current.rust.frontend.startupTelemetry?.sourceIndex?.hashedFiles ?? 0) !== 0)
    ) {
      throw new Error(
        `cross-host project source index was not reused: ${JSON.stringify(current.rust.frontend.startupTelemetry)}`,
      );
    }
    if (current.rust.fault && scenario.actions[0]?.allow_fault !== true) {
      return fail("runtime_fault", 1, { fault: current.rust.fault });
    }
    if (current.comparison && !current.comparison.equal) return fail("difference", 1);
    if (scenario.checkpoint) await saveCheckpoint(scenario.checkpoint.path);
    if (scenario.prepare_traditional_save) {
      const generated = await page.evaluate(async () => {
        await window.__RUSTYERA_TEST__.exportTraditionalSave();
        return window.__RUSTYERA_TEST__.takeDownload(30_000);
      });
      await page.evaluate((bytes) => {
        const nativeClick = globalThis.HTMLInputElement.prototype.click;
        globalThis.HTMLInputElement.prototype.click = function () {
          if (this.type !== "file" || this.webkitdirectory || !this.accept.includes(".sav")) {
            nativeClick.call(this);
            return;
          }
          const file = new globalThis.File([Uint8Array.from(bytes)], "generated.sav", {
            type: "application/octet-stream",
          });
          Object.defineProperty(this, "files", { configurable: true, value: [file] });
          this.dispatchEvent(new globalThis.Event("change", { bubbles: true }));
          globalThis.HTMLInputElement.prototype.click = nativeClick;
        };
      }, generated.bytes);
      trace.emit({
        type: "fixture",
        kind: "traditional_save",
        name: generated.name,
        size: generated.bytes.length,
      });
    }
    for (const action of scenario.actions) {
      if (
        action.when?.output_contains &&
        !current.rust.output.join("\n").includes(action.when.output_contains)
      )
        continue;
      const result = await act(action, "fixed");
      if (result.query || result.state) trace.emit({ type: "query", step: steps, ...result });
      if (isObservableStepAction(action.type) && action.observe !== false) {
        current = await observe(action.settle_auto_enter ?? action.auto_enter !== false);
        if (current.rust.fault && action.allow_fault !== true)
          return fail("runtime_fault", 1, { fault: current.rust.fault });
        if (current.comparison && !current.comparison.equal) return fail("difference", 1);
        if (current.goal.satisfied) return outcome("passed", 0);
      }
    }
    if (current.goal.satisfied || (scenario.mode === "fixed" && !Object.keys(scenario.goal).length))
      return outcome("passed", 0);
    if (args.command === "run") {
      const status = scenario.mode === "autonomous" ? "input_exhausted" : "goal_not_met";
      return fail(status, status === "input_exhausted" ? 2 : 1);
    }

    agentInput = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const line of agentInput) {
      const command = JSON.parse(line);
      if (command.op === "stop") return outcome("stopped", 0);
      if (command.op === "inspect") {
        const values = await page.evaluate(
          (watches) => window.__RUSTYERA_TEST__.inspect(watches),
          command.watches ?? [],
        );
        trace.emit({ type: "inspection", values });
        continue;
      }
      if (command.op === "query") {
        const result = await runAction(page, {
          type: "query",
          locator: command.locator,
          fields: command.fields,
        });
        trace.emit({ type: "query", ...result });
        continue;
      }
      if (command.op === "checkpoint") {
        await saveCheckpoint(command.path);
        continue;
      }
      const action =
        command.op === "step" ? { type: "input", value: command.input } : command.action;
      if (command.op !== "step" && command.op !== "ui")
        throw new Error(`unknown agent operation ${command.op}`);
      const result = await act(action, "agent");
      if (result.query || result.state) trace.emit({ type: "query", ...result });
      if (isObservableStepAction(action.type) && action.observe !== false) {
        current = await observe(action.settle_auto_enter ?? action.auto_enter !== false);
        if (current.rust.fault && action.allow_fault !== true)
          return fail("runtime_fault", 1, { fault: current.rust.fault });
        if (current.comparison && !current.comparison.equal) return fail("difference", 1);
        if (current.goal.satisfied) return outcome("passed", 0);
      }
    }
    return fail("input_exhausted", 2);
  }
}

let exitCode = 3;
try {
  const parsed = parseArgs(process.argv.slice(2));
  exitCode = await execute(parsed);
  if (parsed.command === "serve") process.stdin.pause();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}
process.exitCode = exitCode;
