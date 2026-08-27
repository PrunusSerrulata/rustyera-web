/** Validated, core-owned compatibility metadata; hosts never derive semantic policies. */
export interface CompatibilityIdentity {
  profile: "emuera.em" | "emuera.skia.snake";
  semantic_version: number;
  policy_version: number;
  arithmetic: string;
  rng_algorithm: string;
  rng_state_version: number;
  layout: string;
  save_codec: string;
  services: Array<{ name: string; version: number }>;
}

export function requireCompatibilityIdentity(value: unknown): CompatibilityIdentity {
  const entry = record(value);
  if (entry.profile !== "emuera.em" && entry.profile !== "emuera.skia.snake")
    throw new Error("Runtime 返回了未知的项目兼容 profile");
  if (!Array.isArray(entry.services)) throw new Error("Runtime 返回了无效的兼容服务");
  return {
    profile: entry.profile,
    semantic_version: version(entry.semantic_version),
    policy_version: version(entry.policy_version),
    arithmetic: text(entry.arithmetic),
    rng_algorithm: text(entry.rng_algorithm),
    rng_state_version: version(entry.rng_state_version),
    layout: text(entry.layout),
    save_codec: text(entry.save_codec),
    services: entry.services.map((value) => {
      const service = record(value);
      return { name: text(service.name), version: version(service.version) };
    }),
  };
}

export function compatibilityCbor(value: unknown): Map<number, unknown> {
  const identity = requireCompatibilityIdentity(value);
  return new Map<number, unknown>([
    [0, identity.profile === "emuera.em" ? 0 : 1],
    [1, identity.semantic_version],
    [2, identity.policy_version],
    [3, identity.arithmetic],
    [4, identity.rng_algorithm],
    [5, identity.rng_state_version],
    [6, identity.layout],
    [7, identity.save_codec],
    [
      8,
      identity.services.map(
        (service) =>
          new Map<number, unknown>([
            [0, service.name],
            [1, service.version],
          ]),
      ),
    ],
  ]);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value))
    throw new Error("Runtime 返回了无效的项目兼容身份");
  return value as Record<string, unknown>;
}

function version(value: unknown): number {
  // Runtime JSON crosses WASM as lossless integers, including small u32 values.
  if (typeof value === "bigint" && value > 0n && value <= 0xffff_ffffn) return Number(value);
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 0xffff_ffff)
    throw new Error("Runtime 返回了无效的兼容版本");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Runtime 返回了无效的兼容策略");
  return value;
}

export function formatCompatibilityContext(value: unknown): string {
  if (typeof value !== "object" || value == null) return "";
  const context = value as Record<string, any>;
  const parts: string[] = [];
  if (context.identity != null) {
    try {
      const identity = requireCompatibilityIdentity(context.identity);
      parts.push(
        `profile=${identity.profile}@${identity.semantic_version}/${identity.policy_version}`,
      );
    } catch {
      parts.push("profile=<invalid>");
    }
  }
  if (context.stage) parts.push(`stage=${String(context.stage)}`);
  if (context.api) parts.push(`api=${String(context.api)}`);
  if (context.required_capability) {
    const required = context.required_capability;
    parts.push(
      `requires=${String(required.kind)}.${String(required.operation)}@${required.version?.major ?? "?"}.${required.version?.minor ?? "?"}`,
    );
  }
  return parts.join(" ");
}
