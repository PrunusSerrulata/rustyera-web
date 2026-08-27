import { Decoder, Encoder } from "cbor-x";

// The runtime service ABI requires integer-keyed CBOR maps. cbor-x otherwise
// prefixes JavaScript Map values with its tag 259 extension, which is not part
// of the public protocol and is rejected by the Rust typed decoder.
const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });
const encoder = new Encoder({
  mapsAsObjects: false,
  useRecords: false,
  variableMapSize: true,
  tagUint8Array: false,
});

export function decodeServicePayload(payload: Uint8Array | ArrayLike<number | bigint>): unknown {
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : Uint8Array.from(payload, (value) => {
          const byte = Number(value);
          if (!Number.isInteger(byte) || byte < 0 || byte > 0xff)
            throw new Error("runtime service payload contains a non-byte value");
          return byte;
        });
  return decoder.decode(bytes);
}

export function encodeServicePayload(payload: Map<number, unknown>): Uint8Array {
  return encoder.encode(payload);
}

/** The projection ABI is integer-only; cbor-x otherwise emits safe numbers above u32 as float64
 * and encodes small bigint values nonminimally. Normalize without losing u64 identities. */
export function encodeProjectionServicePayload(payload: Map<number, unknown>): Uint8Array {
  const canonical = (value: unknown): unknown => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value))
        throw new Error("projection service result is not an exact integer");
      return value > 0xffffffff || value < -0x100000000 ? BigInt(value) : value;
    }
    if (typeof value === "bigint") {
      if (value < -(1n << 63n) || value > (1n << 64n) - 1n)
        throw new Error("projection service integer is out of range");
      return value >= -0x100000000n && value <= 0xffffffffn ? Number(value) : value;
    }
    if (Array.isArray(value)) return value.map(canonical);
    if (value instanceof Map)
      return new Map([...value].map(([key, item]) => [key, canonical(item)]));
    if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
    throw new Error("projection service result contains an unsupported CBOR value");
  };
  return encoder.encode(canonical(payload));
}
