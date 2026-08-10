import { describe, expect, it } from "vitest";

import { formatRuntimeFault } from "@/core/runtimeFault";

describe("runtime fault text", () => {
  it("matches the TUI fault code, function, message, and source format", () => {
    expect(
      formatRuntimeFault({
        code: "vm_fault",
        message:
          "an input command cannot execute while user SKIPDISP is active; wrap it in NOSKIP/ENDNOSKIP",
        origin: {
          function: "CAN_COM60",
          source: {
            relative_path: "ERB/コマンド関連/COMF/COMF60 正常位.ERB",
            line: 349,
            byte_column: 17,
          },
        },
      }),
    ).toBe(
      "Runtime 故障 [VmFault] [CAN_COM60]：an input command cannot execute while user SKIPDISP is active; wrap it in NOSKIP/ENDNOSKIP（ERB/コマンド関連/COMF/COMF60 正常位.ERB:349:18）",
    );
  });
});
