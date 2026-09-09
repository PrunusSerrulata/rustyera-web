import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  cpuSampleCommand,
  startCpuSample,
  finishCpuSample,
} from "../scripts/tauri-performance-diagnostics.mjs";

it("uses a bounded native CPU sample with an exact PID and output", () => {
  expect(cpuSampleCommand(123, "/tmp/task-cpu.txt")).toEqual({
    executable: "/bin/sh",
    args: [
      "-c",
      'ulimit -f 16384 && exec /usr/bin/sample "$1" 10 1 -file "$2"',
      "rustyera-cpu-sample",
      "123",
      "/tmp/task-cpu.txt",
    ],
  });
  for (const pid of [0, -1, NaN, 1.5])
    expect(() => cpuSampleCommand(pid, "/tmp/task-cpu.txt")).toThrow();
  expect(() => cpuSampleCommand(123, "relative.txt")).toThrow();
});

afterEach(() => {
  vi.useRealTimers();
});
function fixture(inspectOutput = async () => ({ size: 100 })) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  const dependencies = {
    spawnProcess: vi.fn(() => child),
    inspectOutput,
    reserveOutput: vi.fn(async () => {}),
  };
  return { child, dependencies };
}

it("does not overwrite an existing file or spawn after reservation fails", async () => {
  const f = fixture();
  f.dependencies.reserveOutput.mockRejectedValue(new Error("EEXIST"));
  await expect(startCpuSample(123, "/tmp/cpu.txt", f.dependencies)).rejects.toThrow("EEXIST");
  expect(f.dependencies.spawnProcess).not.toHaveBeenCalled();
});

it("reports process startup failure and releases timers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
  f.child.emit("error", new Error("spawn failed"));
  f.child.emit("close", -1, null);
  expect((await sample.finished).failure).toContain("spawn failed");
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 16 * 1024 * 1024 + 1, null])(
  "rejects invalid terminal output size %s",
  async (size) => {
    const f = fixture(async () => {
      if (size === null) throw new Error("ENOENT");
      return { size };
    });
    const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
    f.child.emit("close", 0, null);
    expect((await sample.finished).failure).toBeTruthy();
    await expect(finishCpuSample(sample, () => {})).rejects.toThrow();
  },
);

it("rejects a nonzero exit even with a valid output file", async () => {
  const f = fixture();
  const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
  f.child.emit("close", 1, null);
  await expect(finishCpuSample(sample, () => {})).rejects.toThrow("exited 1");
});

it("waits for terminal file validation before reporting completion", async () => {
  let inspect;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        inspect = resolve;
      }),
  );
  const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
  let settled = false;
  void sample.finished.then(() => {
    settled = true;
  });
  f.child.emit("close", 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  inspect({ size: 100 });
  await expect(finishCpuSample(sample, () => {})).resolves.toBeUndefined();
  expect(settled).toBe(true);
});

it("times out with TERM then KILL only once and clears timers after closing", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
  await vi.advanceTimersByTimeAsync(30_000);
  sample.stop("again");
  expect(f.child.kill.mock.calls).toEqual([["SIGTERM"]]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  f.child.emit("close", null, "SIGKILL");
  await sample.finished;
  sample.stop("closed");
  expect(f.child.kill).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["wait", "emit", "result"])(
  "preserves the original capture error when secondary %s fails",
  async (kind) => {
    const primary = new Error("capture failed");
    const secondary = new Error("secondary");
    const sample = {
      finished:
        kind === "wait"
          ? Promise.reject(secondary)
          : Promise.resolve({ code: kind === "result" ? 1 : 0 }),
    };
    const run = async () => {
      try {
        throw primary;
      } finally {
        await finishCpuSample(
          sample,
          () => {
            if (kind === "emit") throw secondary;
          },
          primary,
        );
      }
    };
    await expect(run()).rejects.toBe(primary);
    expect(primary.diagnosticFailure).toBeInstanceOf(Error);
  },
);

it("capture cleanup stops only its sampling child", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const sample = await startCpuSample(123, "/tmp/cpu.txt", f.dependencies);
  const primary = new Error("capture failed");
  sample.stop(primary.message);
  expect(f.child.kill.mock.calls).toEqual([["SIGTERM"]]);
  f.child.emit("close", null, "SIGTERM");
  await finishCpuSample(sample, () => {}, primary);
  expect(primary.diagnosticFailure).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
});
