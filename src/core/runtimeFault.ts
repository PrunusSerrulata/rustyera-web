const FAULT_CODES: Record<string, string> = {
  invalid_state: "InvalidState",
  invalid_message: "InvalidMessage",
  project_load: "ProjectLoad",
  vm_fault: "VmFault",
  service_failure: "ServiceFailure",
  resource_limit: "ResourceLimit",
  internal: "Internal",
  unsupported_runtime_feature: "UnsupportedRuntimeFeature",
};

export function formatRuntimeFault(fault: unknown): string {
  if (!fault || typeof fault !== "object") return String(fault ?? "");
  const value = fault as Record<string, any>;
  const origin = value.origin && typeof value.origin === "object" ? value.origin : undefined;
  const source = origin?.source && typeof origin.source === "object" ? origin.source : undefined;
  const rawCode = String(value.code ?? "unknown");
  const code = FAULT_CODES[rawCode] ?? rawCode;
  const context = origin?.function ? ` [${String(origin.function)}]` : "";
  let location = "";
  if (source?.relative_path) {
    location = `（${String(source.relative_path)}`;
    if (source.line != null) location += `:${String(source.line)}`;
    if (source.byte_column != null) {
      if (source.line == null) location += ":?";
      location += `:${String(Number(source.byte_column) + 1)}`;
    }
    location += "）";
  }
  return `Runtime 故障 [${code}]${context}：${String(value.message ?? "")}${location}`;
}
