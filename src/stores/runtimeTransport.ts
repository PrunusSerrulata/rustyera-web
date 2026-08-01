import { toRaw } from "vue";

/** Clone reactive runtime values into objects accepted by Worker and Tauri transports. */
export function transportValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  const raw = toRaw(value as object);
  if (raw instanceof Uint8Array) return new Uint8Array(raw) as T;
  if (raw instanceof Date) return new Date(raw) as T;
  if (raw instanceof Map)
    return new Map(
      [...raw.entries()].map(([key, child]) => [transportValue(key), transportValue(child)]),
    ) as T;
  if (Array.isArray(raw)) return raw.map(transportValue) as T;
  return Object.fromEntries(
    Object.entries(raw).map(([key, child]) => [key, transportValue(child)]),
  ) as T;
}
