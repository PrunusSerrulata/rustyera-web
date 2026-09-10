import { execFileSync } from "node:child_process";

const terminated = new WeakSet();

/** Kill only a child created by this runner, before its PID can be reused. */
export function terminateOwnedChild(
  child,
  signal = "SIGTERM",
  {
    platform = process.platform,
    processGroup = false,
    execute = execFileSync,
    kill = process.kill,
  } = {},
) {
  if (
    !child ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    child.exitCode != null ||
    child.signalCode != null ||
    terminated.has(child)
  )
    return;
  terminated.add(child);
  try {
    if (platform === "win32")
      execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 10_000,
        windowsHide: true,
        stdio: "pipe",
      });
    else if (processGroup) kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    try {
      kill(child.pid, 0);
    } catch (stateError) {
      if (stateError?.code === "ESRCH") return;
    }
    if (error?.code !== "ESRCH") throw error;
  }
}

/** Await pipe closure even on failure; compressed evidence must finish before returning. */
export async function withOwnedChildCleanup(
  child,
  work,
  finishers = [],
  stop = () => terminateOwnedChild(child),
) {
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  child.once("close", close);
  const onSignal = () => {
    try {
      stop();
    } catch (error) {
      failure ??= error;
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result;
  let failure;
  try {
    result = await work();
  } catch (error) {
    failure = error;
  }
  try {
    stop();
  } catch (error) {
    failure ??= error;
  }
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("owned child did not close after termination")),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    failure ??= error;
    child.stdout?.destroy(error);
    child.stderr?.destroy(error);
  } finally {
    clearTimeout(timer);
  }
  const finalized = await Promise.allSettled(finishers.map((finish) => finish()));
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  for (const item of finalized) if (item.status === "rejected") failure ??= item.reason;
  if (failure) throw failure;
  return result;
}
