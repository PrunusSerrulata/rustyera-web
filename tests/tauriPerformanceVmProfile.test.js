import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertVmProfileMode,
  assertVmProfileAction,
  createVmProfileCapture,
  finishProfileCapture,
  vmProfileBuildFeature,
} from "../scripts/tauri-performance-vm-profile.mjs";
import { reusableBuildEnvironment } from "../scripts/tauri-build-cache.mjs";
import { cargoCommandIdentity } from "../scripts/cargo-command-identity.mjs";

const directories = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function outputPath() {
  const path = await mkdtemp(join(tmpdir(), "rustyera-vm-profile-"));
  directories.push(path);
  return join(path, "profile.jsonl");
}
const profile = () => ({
  schemaVersion: 2,
  instance: "1",
  interval: 1024,
  dispatches: "2048",
  droppedSamples: "0",
  incomplete: false,
  counts: [],
  symbols: [],
  positions: {
    active: false,
    startedAtDispatches: "0",
    endedAtDispatches: "2048",
    droppedSamples: "0",
    incomplete: false,
    counts: [],
    locations: [],
  },
});

function boundaryProfile(begin) {
  const snapshot = profile();
  if (begin) {
    snapshot.dispatches = "0";
    snapshot.positions.active = true;
    snapshot.positions.endedAtDispatches = "0";
  }
  return snapshot;
}

const position = { generation: "1", function: "a".repeat(32), instruction: "9007199254740993" };

it("rejects checkpoint-backed sampling before the native window opens", () => {
  expect(() => assertVmProfileAction("checkpoint_change")).toThrow("excludes checkpoint_change");
  expect(() => assertVmProfileAction("wait_change")).not.toThrow();
});

it.each(["command", "start", "replacement"])(
  "validates paired window %s identity",
  async (change) => {
    const path = await outputPath();
    const browser = {
      execute: async (_callback, begin) => {
        const snapshot = boundaryProfile(begin);
        if (!begin && change === "start") snapshot.positions.startedAtDispatches = "1";
        if (!begin && change === "replacement") snapshot.instance = "2";
        return JSON.stringify(snapshot);
      },
    };
    const capture = await createVmProfileCapture(browser, path);
    await capture.capture({ kind: "before", command: 7 });
    const end = capture.capture({ kind: "after", command: change === "command" ? 8 : 7 });
    if (change === "replacement") {
      await end;
      const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
      expect(rows[1].window).toEqual({ valid: false, reason: "vm-replaced" });
    } else await expect(end).rejects.toThrow(/window (command|start)/);
    await capture.close();
  },
);

it.each(["counts", "start", "drops"])("requires begin to clear window %s", async (change) => {
  const browser = {
    execute: async (_callback, begin) => {
      const snapshot = boundaryProfile(begin);
      if (begin && change === "counts") snapshot.positions.counts = [{ ...position, samples: "1" }];
      if (begin && change === "start") {
        snapshot.dispatches = "10";
        snapshot.positions.endedAtDispatches = "10";
      }
      if (begin && change === "drops") {
        snapshot.positions.droppedSamples = "1";
        snapshot.positions.incomplete = true;
      }
      return JSON.stringify(snapshot);
    },
  };
  const capture = await createVmProfileCapture(browser, await outputPath());
  await expect(capture.capture({ kind: "before", command: 7 })).rejects.toThrow();
  await capture.close();
});

it("projects only schema fields and explicitly excludes unpaired samples", async () => {
  const snapshot = profile();
  snapshot.sourceContents = "SECRET_SOURCE";
  snapshot.positions.variables = "SECRET_VARIABLES";
  snapshot.counts = [
    { generation: "1", function: "a".repeat(32), samples: "1", sourceText: "SECRET_SOURCE" },
  ];
  snapshot.positions.counts = [{ ...position, samples: "1", variableValue: "SECRET_VARIABLES" }];
  const path = await outputPath();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(snapshot) },
    path,
  );
  await capture.capture({ kind: "after", command: 7, sourceText: "SECRET_BOUNDARY" });
  await capture.close();
  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain("SECRET");
  expect(JSON.parse(raw).window).toEqual({ valid: false, reason: "missing-before" });
});

it.each(["transport", "validation", "write", "end"])(
  "preserves %s failure while closing native window and file",
  async (stage) => {
    const original = new Error(stage);
    const cleanup = new Error("cleanup");
    const invoke = vi.fn(async (_command, { begin }) => {
      if (!begin) throw cleanup;
      const snapshot = boundaryProfile(begin);
      if (stage === "validation") snapshot.positions.counts = [{ ...position, samples: "bad" }];
      return snapshot;
    });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    const close = vi.fn(async () => {
      throw new Error("close");
    });
    const capture = await createVmProfileCapture(
      {
        execute: async (callback, ...args) => {
          const value = await callback(...args);
          if (args[0] && stage === "transport") throw original;
          return value;
        },
      },
      "/tmp/unused-vm-profile.jsonl",
      {
        open: async () => ({
          writeFile: async () => {
            if (stage === "write") throw original;
          },
          close,
        }),
      },
    );
    let failure;
    try {
      await capture.capture({ kind: "before", command: 7 });
      await capture.capture({ kind: "after", command: 7 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    await expect(finishProfileCapture([() => capture.close()], { error: failure })).rejects.toBe(
      failure,
    );
    expect(invoke).toHaveBeenLastCalledWith("performance_audit_instruction_profile", {
      begin: false,
    });
    expect(close).toHaveBeenCalledOnce();
  },
);

it("retains exact position identities and bounded source metadata only as diagnosis", async () => {
  const snapshot = profile();
  snapshot.positions.counts = [{ ...position, samples: "2" }];
  snapshot.positions.locations = [
    { ...position, name: "函😀", path: "ERB/路径.erb", pathTruncated: false, line: "42" },
  ];
  const path = await outputPath();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(snapshot) },
    path,
  );
  await capture.capture({ kind: "after", command: 7 });
  await capture.close();
  const record = JSON.parse(await readFile(path, "utf8"));
  expect(record.acceptanceTiming).toBe(false);
  expect(record.profile.positions).toEqual({ ...snapshot.positions, unprojectedPositions: 0 });
});

it.each([
  { counts: Array(65537).fill(position) },
  { locations: Array(1025).fill(position) },
  { counts: [{ ...position, instruction: "18446744073709551616", samples: "1" }] },
  {
    counts: [
      { ...position, samples: "1" },
      { ...position, samples: "2" },
    ],
  },
  { startedAtDispatches: "2049" },
  { endedAtDispatches: "2049" },
  { droppedSamples: "1", incomplete: false },
  { locations: [{ ...position, name: "orphan", path: null, line: null, pathTruncated: false }] },
  {
    counts: [{ ...position, samples: "1" }],
    locations: [{ ...position, name: "ok", path: "x".repeat(161), line: "1", pathTruncated: true }],
  },
])("rejects invalid position-window evidence", async (change) => {
  const snapshot = { ...profile(), positions: { ...profile().positions, ...change } };
  const writeFile = vi.fn();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(snapshot) },
    "/tmp/unused-vm-profile.jsonl",
    {
      open: async () => ({ writeFile, close: async () => {} }),
    },
  );
  await expect(capture.capture({ kind: "after", command: 7 })).rejects.toThrow();
  expect(writeFile).not.toHaveBeenCalled();
  await capture.close();
});

it("closes an outstanding native window on cancellation even when output close fails", async () => {
  const invoke = vi.fn(async (_command, { begin }) => boundaryProfile(begin));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const close = vi.fn(async () => {
    throw new Error("file close");
  });
  const capture = await createVmProfileCapture(
    { execute: async (callback, ...args) => callback(...args) },
    "/tmp/unused-vm-profile.jsonl",
    {
      open: async () => ({ writeFile: async () => {}, close }),
    },
  );
  await capture.capture({ kind: "before", command: 7 });
  await expect(capture.close()).rejects.toThrow("file close");
  expect(invoke).toHaveBeenLastCalledWith("performance_audit_instruction_profile", {
    begin: false,
  });
  expect(close).toHaveBeenCalledOnce();
});

it("retains explicit sampling feature identity after runtime environment cleanup", async () => {
  const env = { RUSTYERA_TAURI_PERF_VM_SAMPLE: "1" };
  const enabled = env.RUSTYERA_TAURI_PERF_VM_SAMPLE === "1";
  const cleaned = reusableBuildEnvironment(
    env,
    "snake-runtime-performance.spec.mjs",
    undefined,
    true,
  );
  expect(cleaned.RUSTYERA_TAURI_PERF_VM_SAMPLE).toBeUndefined();
  const identity = (on) =>
    cargoCommandIdentity(
      ["build", "--features", "webdriver,performance-audit" + vmProfileBuildFeature(on)],
      cleaned,
    ).featureIdentity;
  expect(identity(enabled).features).toContain("vm-instruction-profile");
  expect(identity(enabled)).not.toEqual(identity(false));
  const runner = await readFile(join(process.cwd(), "scripts/tauri-test.mjs"), "utf8");
  expect(runner).toContain(
    'const vmInstructionProfile = process.env.RUSTYERA_TAURI_PERF_VM_SAMPLE === "1"',
  );
  expect(runner).toContain("vmProfileBuildFeature(vmInstructionProfile)");
});

it("collects through the real callback using scalar WebDriver transport and exclusive output", async () => {
  const invoke = vi.fn(async (_command, { begin }) => boundaryProfile(begin));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const browser = { execute: async (callback, ...args) => callback(...args) };
  const path = await outputPath();
  const capture = await createVmProfileCapture(browser, path);
  await expect(createVmProfileCapture(browser, path)).rejects.toThrow();
  await capture.capture({ kind: "before", command: 6 });
  await capture.capture({ kind: "after", command: 6 });
  await capture.close();
  await capture.close();
  const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  expect(records.map((record) => record.sequence)).toEqual([0, 1]);
  expect(records[1].profile).toEqual({
    ...profile(),
    positions: { ...profile().positions, unprojectedPositions: 0 },
  });
  expect(invoke).toHaveBeenNthCalledWith(1, "performance_audit_instruction_profile", {
    begin: true,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "performance_audit_instruction_profile", {
    begin: false,
  });
  expect(records.every((record) => record.acceptanceTiming === false)).toBe(true);
  expect(records[1].window).toEqual({ valid: true, reason: null });
  await expect(capture.capture({})).rejects.toThrow("closed");
});

it.each([
  {},
  "null",
  "{",
  "x".repeat(32 * 1024 * 1024 + 1),
  JSON.stringify({ ...profile(), interval: 1 }),
  JSON.stringify({ ...profile(), counts: Array(4097).fill(0) }),
])("rejects malformed or oversized profile data", async (raw) => {
  const capture = await createVmProfileCapture({ execute: async () => raw }, await outputPath());
  try {
    await expect(capture.capture({ kind: "after", command: 6 })).rejects.toThrow();
  } finally {
    await capture.close();
  }
});

it("bounds the number of observations without another invoke", async () => {
  const browser = { execute: vi.fn(async () => JSON.stringify(profile())) };
  const capture = await createVmProfileCapture(browser, await outputPath());
  try {
    for (let command = 1; command <= 64; command++)
      await capture.capture({ kind: "after", command });
    await expect(capture.capture({ kind: "after", command: 65 })).rejects.toThrow("boundary limit");
    expect(browser.execute).toHaveBeenCalledTimes(64);
  } finally {
    await capture.close();
  }
});

it("rejects diagnostic replay and calibration before execution but allows build-only", () => {
  const env = { RUSTYERA_TAURI_PERF_VM_SAMPLE: "1" };
  expect(() => assertVmProfileMode(env)).toThrow("diagnostic capture");
  expect(() => assertVmProfileMode({ ...env, RUSTYERA_TAURI_PERF_PHASE: "calibration" })).toThrow();
  expect(() => assertVmProfileMode(env, { buildOnly: true })).not.toThrow();
  expect(() => assertVmProfileMode({ ...env, RUSTYERA_TAURI_PERF_CAPTURE: "1" })).not.toThrow();
  expect(() =>
    assertVmProfileMode(env, { buildOnly: true, instrumentPerformance: false }),
  ).toThrow();
});

it.each([undefined, null, false, 0, "", new Error("primary")])(
  "always runs both cleanups and preserves primary thrown values",
  async (error) => {
    const close = vi.fn(async () => {
      throw new Error("close");
    });
    const finish = vi.fn(async () => {
      throw new Error("finish/log");
    });
    await expect(finishProfileCapture([close, finish], { error })).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  },
);

it("preserves the first cleanup failure while still running the second", async () => {
  const error = new Error("close");
  const finish = vi.fn(async () => {
    throw new Error("finish");
  });
  await expect(
    finishProfileCapture([
      async () => {
        throw error;
      },
      finish,
    ]),
  ).rejects.toBe(error);
  expect(finish).toHaveBeenCalledOnce();
});

it.each([
  { counts: [null] },
  { counts: [{ generation: "1", function: "bad", samples: "1" }] },
  { dispatches: "18446744073709551616" },
  { instance: "0" },
  { symbols: [{ generation: "1", function: "a".repeat(32), name: "x".repeat(65) }] },
])("rejects invalid entries before writing", async (change) => {
  const writeFile = vi.fn();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify({ ...profile(), ...change }) },
    "/tmp/unused-vm-profile.jsonl",
    {
      open: async () => ({ writeFile, close: async () => {} }),
    },
  );
  await expect(capture.capture({ kind: "before", command: 1 })).rejects.toThrow();
  expect(writeFile).not.toHaveBeenCalled();
  await capture.close();
});

it.each(["invoke", "write", "close"])(
  "propagates %s failures and permits cleanup",
  async (stage) => {
    const error = new Error(stage);
    const close = vi.fn(async () => {
      if (stage === "close") throw error;
    });
    const capture = await createVmProfileCapture(
      {
        execute: async () => {
          if (stage === "invoke") throw error;
          return JSON.stringify(profile());
        },
      },
      "/tmp/unused-vm-profile.jsonl",
      {
        open: async () => ({
          writeFile: async () => {
            if (stage === "write") throw error;
          },
          close,
        }),
      },
    );
    if (stage === "close") {
      await capture.capture({ kind: "after", command: 1 });
      await expect(capture.close()).rejects.toBe(error);
    } else {
      await expect(capture.capture({ kind: "after", command: 1 })).rejects.toBe(error);
      await capture.close();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);

it("bounds cumulative file bytes before writing the overflowing record", async () => {
  const maximum = "18446744073709551615";
  const large = {
    ...profile(),
    dispatches: maximum,
    counts: Array.from({ length: 4096 }, (_, index) => ({
      generation: maximum,
      function: index.toString(16).padStart(32, "0"),
      samples: maximum,
    })),
    symbols: Array.from({ length: 128 }, (_, index) => ({
      generation: maximum,
      function: index.toString(16).padStart(32, "0"),
      name: "\0".repeat(64),
    })),
  };
  large.positions.counts = Array.from({ length: 65536 }, (_, index) => ({
    generation: maximum,
    function: index.toString(16).padStart(32, "0"),
    instruction: maximum,
    samples: maximum,
  }));
  large.positions.unprojectedPositions = 65536;
  let written = 0;
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(large) },
    "/tmp/unused-vm-profile.jsonl",
    {
      open: async () => ({
        writeFile: async (line) => {
          written += Buffer.byteLength(line);
        },
        close: async () => {},
      }),
    },
  );
  try {
    await expect(
      (async () => {
        for (let command = 1; command <= 64; command++)
          await capture.capture({ kind: "after", command });
      })(),
    ).rejects.toThrow("output limit");
    expect(written).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(written).toBeGreaterThan(240 * 1024 * 1024);
  } finally {
    await capture.close();
  }
});

it("retains independent opcode counts and exposes unprojected positions", async () => {
  const snapshot = profile();
  snapshot.opcodes = {
    incomplete: false,
    droppedSamples: "0",
    counts: [{ opcode: 65535, samples: "2", secret: 1 }],
  };
  snapshot.positions.counts = [{ ...position, samples: "2" }];
  snapshot.positions.unprojectedPositions = 1;
  const path = await outputPath();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(snapshot) },
    path,
  );
  await capture.capture({ kind: "after", command: 6 });
  await capture.close();
  const row = JSON.parse(await readFile(path, "utf8"));
  expect(row.profile.opcodes.counts).toEqual([{ opcode: 65535, samples: "2" }]);
  expect(row.profile.positions.unprojectedPositions).toBe(1);
  expect(row.profile.positions.incomplete).toBe(false);
});

it.each(["duplicate", "range", "missing", "projection", "excess-loss", "excess-total"])(
  "rejects malformed additive %s data",
  async (kind) => {
    const snapshot = profile();
    snapshot.opcodes = {
      incomplete: false,
      droppedSamples: "0",
      counts: [{ opcode: 1, samples: "2" }],
    };
    if (kind === "duplicate") snapshot.opcodes.counts.push({ opcode: 1, samples: "1" });
    if (kind === "range") snapshot.opcodes.counts[0].opcode = 65536;
    if (kind === "missing") snapshot.opcodes.counts[0].samples = "1";
    if (kind === "projection") snapshot.positions.unprojectedPositions = 1;
    if (kind === "excess-loss") {
      snapshot.opcodes.incomplete = true;
      snapshot.opcodes.droppedSamples = "18446744073709551615";
    }
    if (kind === "excess-total") {
      snapshot.opcodes.incomplete = true;
      snapshot.opcodes.counts[0].samples = "3";
    }
    const capture = await createVmProfileCapture(
      { execute: async () => JSON.stringify(snapshot) },
      await outputPath(),
    );
    try {
      await expect(capture.capture({ kind: "after", command: 6 })).rejects.toThrow();
    } finally {
      await capture.close();
    }
  },
);

it("preserves a bounded incomplete opcode distribution", async () => {
  const snapshot = profile();
  snapshot.opcodes = {
    incomplete: true,
    droppedSamples: "1",
    counts: [{ opcode: 1, samples: "1" }],
  };
  const path = await outputPath();
  const capture = await createVmProfileCapture(
    { execute: async () => JSON.stringify(snapshot) },
    path,
  );
  try {
    await capture.capture({ kind: "after", command: 6 });
  } finally {
    await capture.close();
  }
  expect(JSON.parse(await readFile(path, "utf8")).profile.opcodes).toEqual(snapshot.opcodes);
});
