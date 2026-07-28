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
  installRemoteFileSystem,
  isolatedProject,
  loadScenario,
  observationFromSnapshot,
  runAction,
  shellWords,
} from "./web-test-lib.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

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
  const webProject = await isolatedProject(scenario.project);
  let referenceProject;
  let reference;
  let browser;
  let server;
  let page;
  const consoleMessages = [];
  let previousOutput = [];
  let referenceObservation;
  let steps = 0;
  const deadline = Date.now() + scenario.limits.timeout_seconds * 1000;
  const emitResult = (status, extra = {}) =>
    trace.emit({ type: "result", status, seed: scenario.seed, trace: tracePath, ...extra });
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
    emitResult(status, extra);
    return exitCode;
  };
  try {
    process.env.VITE_RUSTYERA_TEST = "1";
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repository, ".playwright-browsers");
    const [{ createServer }, { chromium }] = await Promise.all([
      import("vite"),
      import("@playwright/test"),
    ]);
    server = await createServer({
      root: repository,
      mode: "test",
      define: { "import.meta.env.VITE_RUSTYERA_TEST": JSON.stringify("1") },
      plugins: [
        {
          name: "rustyera-test-wasm",
          configureServer(viteServer) {
            viteServer.middlewares.use((request, response, next) => {
              const name = request.url?.match(/^\/__rustyera_test_wasm\/([^?]+)/)?.[1];
              if (!name || !["era_web_wasm.js", "era_web_wasm_bg.wasm"].includes(name))
                return next();
              response.setHeader(
                "Content-Type",
                name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
              );
              createReadStream(path.join(repository, "public/wasm", name)).pipe(response);
            });
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        watch: { ignored: ["**/.rustyera/**"] },
      },
    });
    await server.listen();
    const address = server.httpServer.address();
    const port = typeof address === "object" ? address.port : 1420;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    page.on("console", (message) =>
      consoleMessages.push({ type: message.type(), text: message.text() }),
    );
    await installRemoteFileSystem(page, webProject.project);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => window.__RUSTYERA_TEST__ != null);
    const stateBytes = scenario.start.path ? [...(await readFile(scenario.start.path))] : undefined;
    await page.evaluate(
      ({ start, seed, clock, stateBytes }) =>
        window.__RUSTYERA_TEST__.configure({
          start: {
            type: start.type,
            seed,
            bytes: stateBytes ? new Uint8Array(stateBytes) : undefined,
          },
          clock,
        }),
      { start: scenario.start, seed: scenario.seed, clock: scenario.clock, stateBytes },
    );
    for (const action of scenario.before_open_actions ?? []) await runAction(page, action);
    await page.getByRole("button", { name: "打开 Era 项目…", exact: true }).click();

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

    async function observe() {
      for (
        let automaticEnters = 0;
        automaticEnters <= scenario.limits.max_steps;
        automaticEnters += 1
      ) {
        if (Date.now() > deadline) throw new Error("scenario timeout exhausted");
        const snapshot = await page.evaluate(
          (timeout) => window.__RUSTYERA_TEST__.waitForStableObservation(timeout),
          Math.max(1, deadline - Date.now()),
        );
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
          rust.wait?.kind !== "enter_key"
        )
          return event;
        trace.emit({
          type: "action",
          step: steps,
          source: "automatic_enter",
          action: { type: "input", value: "" },
        });
        await runAction(page, { type: "input", value: "" });
        if (reference) referenceObservation = await reference.step("", scenario.watches);
      }
      throw new Error("automatic Enter budget exhausted");
    }

    async function act(action, source) {
      if (steps >= scenario.limits.max_steps) throw new Error("step budget exhausted");
      trace.emit({ type: "action", step: steps + 1, source, action });
      const result = await runAction(page, action);
      if (reference && action.advances_game && result.semanticInput == null)
        throw new Error(`${action.type} that advances a compared game must declare semantic_input`);
      if (reference && result.semanticInput != null)
        referenceObservation = await reference.step(String(result.semanticInput), scenario.watches);
      if (["input", "click", "dblclick", "press"].includes(action.type)) steps += 1;
      return result;
    }

    async function saveCheckpoint(configuredPath) {
      const target = path.resolve(
        configuredPath
          ? path.resolve(path.dirname(scenario.path), configuredPath)
          : path.join(path.dirname(tracePath), "checkpoint.snapshot"),
      );
      await page.evaluate(() => window.__RUSTYERA_TEST__.exportSnapshot());
      const download = await page.evaluate(() => window.__RUSTYERA_TEST__.takeDownload(10_000));
      await writeFile(target, new Uint8Array(download.bytes));
      trace.emit({ type: "checkpoint", path: target });
    }

    trace.emit({
      type: "start",
      scenario: scenario.path,
      project: scenario.project,
      mode: scenario.mode,
      start: scenario.start.type,
      seed: scenario.seed,
      clock: scenario.clock ?? "2026-01-01T00:00:00Z",
      trace: tracePath,
    });
    let current = await observe();
    if (current.rust.fault) return fail("runtime_fault", 1, { fault: current.rust.fault });
    if (current.comparison && !current.comparison.equal) return fail("difference", 1);
    if (scenario.checkpoint) await saveCheckpoint(scenario.checkpoint.path);
    for (const action of scenario.actions) {
      if (
        action.when?.output_contains &&
        !current.rust.output.join("\n").includes(action.when.output_contains)
      )
        continue;
      const result = await act(action, "fixed");
      if (result.query || result.state) trace.emit({ type: "query", step: steps, ...result });
      if (["input", "click", "dblclick", "press"].includes(action.type)) {
        current = await observe();
        if (current.rust.fault) return fail("runtime_fault", 1, { fault: current.rust.fault });
        if (current.comparison && !current.comparison.equal) return fail("difference", 1);
        if (current.goal.satisfied) return (emitResult("passed"), 0);
      }
    }
    if (current.goal.satisfied || (scenario.mode === "fixed" && !Object.keys(scenario.goal).length))
      return (emitResult("passed"), 0);
    if (args.command === "run") {
      const status = scenario.mode === "autonomous" ? "input_exhausted" : "goal_not_met";
      return fail(status, status === "input_exhausted" ? 2 : 1);
    }

    const input = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const line of input) {
      const command = JSON.parse(line);
      if (command.op === "stop") return (emitResult("stopped"), 0);
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
      if (["input", "click", "dblclick", "press"].includes(action.type)) {
        current = await observe();
        if (current.rust.fault) return fail("runtime_fault", 1, { fault: current.rust.fault });
        if (current.comparison && !current.comparison.equal) return fail("difference", 1);
        if (current.goal.satisfied) return (emitResult("passed"), 0);
      }
    }
    return fail("input_exhausted", 2);
  } catch (error) {
    await captureFailureArtifacts();
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    trace.emit({
      type: "error",
      message,
    });
    if (message.includes("assertion failed at")) {
      emitResult("assertion_failure");
      return 1;
    }
    emitResult("infrastructure_failure");
    return 3;
  } finally {
    reference?.close();
    await browser?.close();
    await server?.close();
    await referenceProject?.close();
    await webProject.close();
    await trace.close();
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
