import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

import { observationFromSnapshot } from "./web-test-runtime.mjs";

export const REFERENCE_SCHEMA_VERSION = 2;

const WAIT_KIND = {
  enter_key: "EnterKey",
  any_key: "AnyKey",
  integer: "IntValue",
  integer_value: "IntValue",
  string: "StrValue",
  string_value: "StrValue",
  void: "Void",
  any_value: "AnyValue",
  integer_button: "IntButton",
  string_button: "StrButton",
  primitive_mouse_key: "PrimitiveMouseKey",
};

export class ReferenceProcess {
  constructor(command, pathCommand, timeoutMs = 30_000) {
    this.pathCommand = pathCommand;
    this.timeoutMs = timeoutMs;
    this.child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.nextId = 1;
    this.previous = [];
  }
  convertPath(value) {
    if (!this.pathCommand?.length) return value;
    const result = spawnSync(this.pathCommand[0], [...this.pathCommand.slice(1), value], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`reference path conversion failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  async request(op, fields = {}) {
    const request = { id: this.nextId++, op, ...fields };
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    const response = await Promise.race([
      this.iterator.next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reference process timed out")), this.timeoutMs),
      ),
    ]);
    if (response.done) throw new Error("reference process exited without a response");
    const value = JSON.parse(response.value);
    if (!value.ok) throw new Error(`reference request failed: ${value.error}`);
    if (value.schemaVersion !== REFERENCE_SCHEMA_VERSION || value.id !== request.id)
      throw new Error("reference schema or response id mismatch");
    this.referenceCommit = value.referenceCommit;
    return value.result;
  }
  async start(scenario) {
    const capabilities = await this.request("capabilities");
    const required =
      scenario.start.type === "traditional_save" ? ["load", "loadSave", "run"] : ["load", "run"];
    for (const operation of required)
      if (!capabilities.operations.includes(operation))
        throw new Error(`reference CLI missing ${operation}`);
    let result = await this.request("load", {
      gameDir: this.convertPath(scenario.project),
      seed: scenario.seed,
      watch: scenario.watches,
    });
    if (scenario.start.type === "traditional_save")
      result = await this.request("loadSave", {
        savePath: this.convertPath(scenario.start.path),
        watch: scenario.watches,
      });
    return this.observe(result);
  }
  async step(input, watches) {
    return this.observe(await this.request("run", { inputs: [input], watch: watches }));
  }
  observe(result) {
    const output = (result.output ?? []).map(String);
    const observation = observationFromSnapshot(
      {
        output,
        wait: {
          kind: result.inputRequest?.InputType,
          system_input: result.inputRequest?.IsSystemInput,
        },
        phase: result.termination,
      },
      this.previous,
    );
    this.previous = output;
    return {
      ...observation,
      termination: result.termination,
      watches: result.watches ?? {},
      random_seed: result.randomSeed,
      random_algorithm: result.randomAlgorithm,
      reference_commit: this.referenceCommit,
    };
  }
  close() {
    this.lines.close();
    this.child.kill();
  }
}

export function compareObservations(rust, reference, comparison = {}) {
  const ignored = (comparison.ignore_output ?? []).map((value) => new RegExp(value));
  const normalize = (values) =>
    values
      .map((value) => String(value).replaceAll("\r", "").trimEnd())
      .filter((value) => !ignored.some((pattern) => pattern.test(value)));
  const differences = {};
  const left = normalize(rust.output_delta.added),
    right = normalize(reference.output_delta.added);
  if (JSON.stringify(left) !== JSON.stringify(right))
    differences.output_delta = { rust: left, reference: right };
  const expected = { ...WAIT_KIND, ...(comparison.wait_kind_map ?? {}) }[rust.wait?.kind];
  if (expected && expected !== reference.wait?.kind)
    differences.wait_kind = { rust: rust.wait?.kind, reference: reference.wait?.kind };
  if (JSON.stringify(rust.watches ?? {}) !== JSON.stringify(reference.watches ?? {}))
    differences.watches = { rust: rust.watches ?? {}, reference: reference.watches ?? {} };
  return { equal: Object.keys(differences).length === 0, differences };
}
