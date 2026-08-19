/** Yield browser work without relying on timer throttling. */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/** Wait until an active document has crossed a real rendering opportunity. */
export async function yieldToPaint(): Promise<void> {
  if (
    typeof requestAnimationFrame !== "function" ||
    typeof document === "undefined" ||
    document.visibilityState !== "visible"
  ) {
    await yieldToMainThread();
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const painted = new Promise<"painted">((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve("painted")));
  });
  const outcome = await Promise.race([
    painted,
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 250);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome === "timed-out") await yieldToMainThread();
}
