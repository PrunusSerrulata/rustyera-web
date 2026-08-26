/** Normalize a Tauri raw IPC body to an exact byte view without copying its backing buffer. */
export function ipcBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  )
    return new Uint8Array(value as ArrayBuffer);
  throw new TypeError("Tauri raw response is not an ArrayBuffer or ArrayBufferView");
}
