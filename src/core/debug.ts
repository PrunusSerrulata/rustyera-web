export function debugStopToken(stop: any): any | undefined {
  return stop?.stop;
}

export function selectedDebugFiber(stop: any): number | bigint | undefined {
  return stop?.selected_fiber ?? undefined;
}

export function sourceLineStepCommand(stop: any): any | undefined {
  const token = debugStopToken(stop);
  const fiber = selectedDebugFiber(stop);
  return token && fiber != null
    ? { type: "step", stop: token, fiber_id: fiber, kind: "source_line" }
    : undefined;
}

export function refreshDebugStop(current: any, response: any): any {
  return current && response?.stop ? { ...current, stop: response.stop } : current;
}

export function isStaleDebugGrantError(error: any): boolean {
  const code = String(error?.code ?? "")
    .toLowerCase()
    .replaceAll("_", "");
  return (
    code === "permissiondenied" && String(error?.message ?? "").includes("debug grant is stale")
  );
}

export function sameDebugGrant(left: any, right: any): boolean {
  return stableDebugText(left) === stableDebugText(right);
}

export function debugVariableKey(value: any): string {
  return stableDebugText(value?.symbol_key ?? value?.reference?.symbol_key ?? value);
}

export function formatDebugValue(value: any): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if ("type" in value && "value" in value) {
    const nested = value.value;
    return typeof nested === "object" ? stableDebugText(nested) : String(nested);
  }
  return stableDebugText(value);
}

function stableDebugText(value: any): string {
  return (
    JSON.stringify(value, (_key, child) =>
      typeof child === "bigint" ? child.toString() : child,
    ) ?? String(value)
  );
}
