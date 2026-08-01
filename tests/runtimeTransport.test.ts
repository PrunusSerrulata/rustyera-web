import { reactive } from "vue";
import { describe, expect, it } from "vitest";

import { transportValue } from "@/stores/runtimeTransport";

describe("runtime transport values", () => {
  it("removes Vue proxies while preserving binary and map values", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const source = reactive({
      payload: new Map<number, unknown>([[0, bytes]]),
      nested: [{ enabled: true }],
    });

    const transported = transportValue(source);

    expect(transported).toEqual({
      payload: new Map<number, unknown>([[0, bytes]]),
      nested: [{ enabled: true }],
    });
    expect(transported).not.toBe(source);
    expect(transported.payload).not.toBe(source.payload);
    expect(transported.payload.get(0)).not.toBe(bytes);
  });
});
