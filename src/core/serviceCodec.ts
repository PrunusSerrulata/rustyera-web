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

export function decodeServicePayload(payload: Uint8Array): unknown {
  return decoder.decode(payload);
}

export function encodeServicePayload(payload: Map<number, unknown>): Uint8Array {
  return encoder.encode(payload);
}
