const IPC_INTEGER_TAG = "$rustyeraInteger";
const IPC_BYTES_TAG = "$rustyeraBytes";
const NOT_TAGGED = Symbol("not-tagged");

export function decodeIpcValue<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => decodeIpcValue(item)) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const tagged = decodeTaggedRecord(record);
    if (tagged !== NOT_TAGGED) return tagged as T;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeIpcValue(item)]),
    ) as T;
  }
  return value as T;
}

export function encodeIpcBytes(bytes: Uint8Array): Record<string, string> {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return { [IPC_BYTES_TAG]: native.call(bytes) };
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  return { [IPC_BYTES_TAG]: btoa(binary) };
}

function decodeBase64(encoded: string): Uint8Array {
  const native = (Uint8Array as typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array })
    .fromBase64;
  if (native) return native(encoded);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeTaggedRecord(record: Record<string, unknown>): unknown | typeof NOT_TAGGED {
  const hasBytes = Object.prototype.hasOwnProperty.call(record, IPC_BYTES_TAG);
  const hasInteger = Object.prototype.hasOwnProperty.call(record, IPC_INTEGER_TAG);
  if (!hasBytes && !hasInteger) return NOT_TAGGED;
  if (Object.keys(record).length !== 1) return NOT_TAGGED;
  if (hasBytes && typeof record[IPC_BYTES_TAG] === "string")
    return decodeBase64(record[IPC_BYTES_TAG]);
  if (
    hasInteger &&
    typeof record[IPC_INTEGER_TAG] === "string" &&
    /^-?\d+$/.test(record[IPC_INTEGER_TAG])
  )
    return BigInt(record[IPC_INTEGER_TAG]);
  return NOT_TAGGED;
}

function decodeParsedIpcValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      value[index] = decodeParsedIpcValue(value[index]);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const tagged = decodeTaggedRecord(record);
  if (tagged !== NOT_TAGGED) return tagged;
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key))
      record[key] = decodeParsedIpcValue(record[key]);
  }
  return record;
}

export function decodeIpcResponse<T>(value: unknown): T {
  const isArrayBuffer = Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  if (isArrayBuffer || ArrayBuffer.isView(value)) {
    let bytes: Uint8Array;
    if (isArrayBuffer) bytes = new Uint8Array(value as ArrayBuffer);
    else {
      const view = value as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    // Binary IPC responses can contain large presentation deltas. Replace tagged leaves in the
    // parser-owned tree without recursively cloning every array and object.
    return decodeParsedIpcValue(JSON.parse(new TextDecoder().decode(bytes))) as T;
  }
  return decodeIpcValue(value);
}

export function encodeIpcValue(value: unknown): unknown {
  if (typeof value === "bigint") return { [IPC_INTEGER_TAG]: value.toString() };
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(encodeIpcValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeIpcValue(item)]),
    );
  }
  return value;
}
