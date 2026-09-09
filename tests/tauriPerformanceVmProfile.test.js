import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertVmProfileMode,
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
  schemaVersion: 1,
  instance: "1",
  interval: 1024,
  dispatches: "2048",
  droppedSamples: "0",
  incomplete: false,
  counts: [],
  symbols: [],
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
  const invoke = vi.fn(async () => profile());
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  const browser = { execute: async (callback) => callback() };
  const path = await outputPath();
  const capture = await createVmProfileCapture(browser, path);
  await expect(createVmProfileCapture(browser, path)).rejects.toThrow();
  await capture.capture({ kind: "before", command: 6 });
  await capture.capture({ kind: "after", command: 6 });
  await capture.close();
  await capture.close();
  const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  expect(records.map((record) => record.sequence)).toEqual([0, 1]);
  expect(records[1].profile).toEqual(profile());
  expect(invoke).toHaveBeenCalledWith("performance_audit_instruction_profile");
  await expect(capture.capture({})).rejects.toThrow("closed");
});

it.each([
  {},
  "null",
  "{",
  "x".repeat(1024 * 1024 + 1),
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
    expect(written).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(written).toBeGreaterThan(15 * 1024 * 1024);
  } finally {
    await capture.close();
  }
});
