export async function finalizeBrowserGameRun({
  outcome,
  runError,
  monitor,
  monitorError,
  cleanups,
  trace,
  classifyError,
}) {
  let stopError;
  try {
    await monitor?.stop();
  } catch (error) {
    stopError = error;
  }

  const cleanupResults = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  const cleanupError = cleanupResults.find((result) => result.status === "rejected")?.reason;
  const selectedError = monitorError() ?? stopError ?? runError ?? cleanupError;
  const finalOutcome = selectedError ? classifyError(selectedError) : outcome;
  if (!finalOutcome) throw new Error("browser game run completed without an outcome");

  if (selectedError) {
    const message =
      selectedError instanceof Error
        ? (selectedError.stack ?? selectedError.message)
        : String(selectedError);
    trace.emit({ type: "error", message });
  }
  trace.emit({ type: "result", ...finalOutcome.result });
  await trace.close();
  return finalOutcome.exitCode;
}
