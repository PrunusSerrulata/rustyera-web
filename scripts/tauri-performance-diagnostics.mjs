import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";

const MAXIMUM_SAMPLE_BYTES = 16 * 1024 * 1024;
export function cpuSampleCommand(pid, output) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("CPU sample needs the exact Tauri PID");
  if (!path.isAbsolute(output)) throw new Error("CPU sample needs an absolute output path");
  // macOS /bin/sh documents -f in 1024-byte units. RLIMIT_FSIZE bounds writes between polls.
  // Dynamic values are positional arguments, never interpolated into shell source.
  return {
    executable: "/bin/sh",
    args: [
      "-c",
      'ulimit -f 16384 && exec /usr/bin/sample "$1" 10 1 -file "$2"',
      "rustyera-cpu-sample",
      String(pid),
      output,
    ],
  };
}

async function reserveOutput(output) {
  const file = await open(output, "wx");
  await file.close();
}

/** Diagnostic samples perturb timing. Use only in an explicitly labelled diagnostic capture. */
export async function startCpuSample(pid, output, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const inspectOutput = dependencies.inspectOutput ?? stat;
  const reserve = dependencies.reserveOutput ?? reserveOutput;
  const command = cpuSampleCommand(pid, output);
  await reserve(output);
  const startedAt = Date.now();
  const child = spawnProcess(command.executable, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  let failure;
  let killTimer;
  let closed = false;
  let stopping = false;
  const stop = (reason) => {
    if (closed || stopping) return;
    stopping = true;
    failure ??= reason;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (diagnostic.length < 8192)
        diagnostic += chunk.toString().slice(0, 8192 - diagnostic.length);
    });
  const timeout = setTimeout(() => stop("CPU sample exceeded 30s"), 30_000);
  const finished = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = String(error);
    });
    child.once("close", async (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      let bytes;
      try {
        bytes = (await inspectOutput(output)).size;
        if (bytes <= 0 || bytes > MAXIMUM_SAMPLE_BYTES)
          failure ??= "CPU sample output is empty or oversized";
      } catch (error) {
        failure ??= "CPU sample output unavailable: " + String(error);
      }
      resolve({
        ...command,
        pid,
        output,
        startedAt,
        finishedAt: Date.now(),
        code,
        signal,
        bytes,
        failure,
        diagnostic,
      });
    });
  });
  return { finished, stop };
}

export async function finishCpuSample(sample, emitResult, primaryError) {
  if (!sample) return;
  try {
    const result = await sample.finished;
    await emitResult(result);
    if (result.code !== 0 || result.failure)
      throw new Error(result.failure ?? "CPU sample exited " + result.code);
  } catch (error) {
    if (primaryError == null) throw error;
    // Preserve the first capture failure, even when secondary result logging itself fails.
    try {
      primaryError.diagnosticFailure = error;
    } catch {
      /* A frozen/non-object error still wins. */
    }
  }
}
