import { describe, expect, it } from "vitest";

import { decodeIpcResponse, decodeIpcValue } from "@/platform/tauriBridge/ipcCodec";

describe("Tauri binary IPC decoding", () => {
  it("revives tagged integers and bytes inside the parser-owned response tree", () => {
    const payload = {
      events: [
        {
          sequence: { $rustyeraInteger: "9007199254740992" },
          correlationId: { $rustyeraInteger: "-9007199254740993" },
          dataBytes: { $rustyeraBytes: "AAF//w==" },
          ordinary: { nested: [1, "text"] },
        },
      ],
    };
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const padded = new Uint8Array(encoded.length + 5);
    padded.set(Uint8Array.of(0xff, 0xfe), 0);
    padded.set(encoded, 2);
    padded.set(Uint8Array.of(0xff, 0xfe, 0xfd), encoded.length + 2);
    const view = new DataView(padded.buffer, 2, encoded.length);

    const expected = {
      events: [
        {
          sequence: 9_007_199_254_740_992n,
          correlationId: -9_007_199_254_740_993n,
          dataBytes: Uint8Array.of(0, 1, 127, 255),
          ordinary: { nested: [1, "text"] },
        },
      ],
    };
    expect(decodeIpcResponse(view)).toEqual(expected);
    expect(decodeIpcValue(payload)).toEqual(expected);
  });

  it("preserves malformed, wrong-type, and multi-field tag-shaped objects", () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        malformed: { $rustyeraInteger: "1.5" },
        extra: { $rustyeraInteger: "42", label: "literal" },
        wrongBytes: { $rustyeraBytes: [0, 1] },
        extraBytes: { $rustyeraBytes: "AAF//w==", label: "literal" },
      }),
    );

    expect(decodeIpcResponse(encoded.buffer)).toEqual({
      malformed: { $rustyeraInteger: "1.5" },
      extra: { $rustyeraInteger: "42", label: "literal" },
      wrongBytes: { $rustyeraBytes: [0, 1] },
      extraBytes: { $rustyeraBytes: "AAF//w==", label: "literal" },
    });
  });
});
