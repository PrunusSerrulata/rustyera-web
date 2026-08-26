import { describe, expect, it } from "vitest";

import { ipcBytes } from "@/platform/tauriBridge/ipcBytes";

describe("Tauri raw byte normalization", () => {
  it("preserves Uint8Array, ArrayBuffer, and offset views without full-buffer copies", () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    expect(ipcBytes(bytes)).toBe(bytes);
    expect([...ipcBytes(bytes.buffer)]).toEqual([1, 2, 3, 4]);

    const view = new DataView(bytes.buffer, 1, 2);
    const normalized = ipcBytes(view);
    expect([...normalized]).toEqual([2, 3]);
    expect(normalized.buffer).toBe(bytes.buffer);
    expect(normalized.byteOffset).toBe(1);
  });
});
