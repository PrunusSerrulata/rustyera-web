import { RuntimeServiceError } from "@/core/runtimeServiceError";

/** Validate the bounded deterministic integer-only CBOR used by projection queries.
 * Run before cbor-x so duplicate map keys cannot disappear during materialization. */
export function validateProjectionCbor(bytes: Uint8Array): void {
  let offset = 0;
  let items = 0;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const fail = (message: string): never => {
    throw new RuntimeServiceError("invalid_request", `invalid projection CBOR: ${message}`);
  };
  const byte = (): number => {
    if (offset >= bytes.length) return fail("truncated value");
    return bytes[offset++];
  };
  const argument = (additional: number): bigint => {
    if (additional < 24) return BigInt(additional);
    const sizes: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const size = sizes[additional];
    if (size == null) return fail("indefinite or reserved length");
    let value = 0n;
    for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(byte());
    const minimum = size === 1 ? 24n : 1n << BigInt((size / 2) * 8);
    if (value < minimum) return fail("nonminimal integer or length");
    return value;
  };
  const count = (value: bigint): number => {
    if (value > BigInt(bytes.length)) return fail("length exceeds payload");
    return Number(value);
  };
  const visit = (depth: number): bigint | undefined => {
    if (depth > 256 || ++items > 250_000)
      throw new RuntimeServiceError(
        "resource_limit",
        "projection CBOR nesting or item limit exceeded",
      );
    const initial = byte();
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7) {
      if (![20, 21, 22].includes(additional))
        return fail("floats, undefined and simple values are not permitted");
      return undefined;
    }
    if (major === 6) return fail("tags are not permitted");
    const value = argument(additional);
    if (major === 0) return value;
    if (major === 1) return undefined;
    const length = count(value);
    if (major === 2 || major === 3) {
      if (offset + length > bytes.length) return fail("truncated string");
      if (major === 3) {
        try {
          utf8.decode(bytes.subarray(offset, offset + length));
        } catch {
          return fail("invalid UTF-8 string");
        }
      }
      offset += length;
    } else if (major === 4) {
      for (let index = 0; index < length; index += 1) visit(depth + 1);
    } else if (major === 5) {
      let previous = -1n;
      for (let index = 0; index < length; index += 1) {
        const key = visit(depth + 1);
        if (key == null || key <= previous)
          return fail("map keys must be distinct ascending unsigned integers");
        previous = key;
        visit(depth + 1);
      }
    } else return fail("unknown major type");
    return undefined;
  };
  visit(0);
  if (offset !== bytes.length) fail("trailing bytes");
}
