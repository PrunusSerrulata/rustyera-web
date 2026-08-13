const IPC_INTEGER_TAG = "$rustyeraInteger";
const IPC_BYTES_TAG = "$rustyeraBytes";

export function decodeIpcValue<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((item) => decodeIpcValue(item)) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record[IPC_BYTES_TAG] === "string")
      return decodeBase64(record[IPC_BYTES_TAG]) as T;
    if (
      Object.keys(record).length === 1 &&
      typeof record[IPC_INTEGER_TAG] === "string" &&
      /^-?\d+$/.test(record[IPC_INTEGER_TAG])
    ) {
      return BigInt(record[IPC_INTEGER_TAG]) as T;
    }
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

export function decodeIpcResponse<T>(value: unknown): T {
  const isArrayBuffer = Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  if (isArrayBuffer || ArrayBuffer.isView(value)) {
    let bytes: Uint8Array;
    if (isArrayBuffer) bytes = new Uint8Array(value as ArrayBuffer);
    else {
      const view = value as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    return decodeIpcValue(JSON.parse(new TextDecoder().decode(bytes)));
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
