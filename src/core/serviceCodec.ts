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
