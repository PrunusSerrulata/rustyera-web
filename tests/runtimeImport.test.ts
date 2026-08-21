import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "@/core/types";
import { RuntimeImportState } from "@/stores/runtimeImport";

describe("runtime state import", () => {
  it("releases snapshot bytes after the Runtime commits the transfer", async () => {
    const send = vi.fn<(message: RuntimeMessage) => Promise<number | bigint>>(async () => 1);
    const state = new RuntimeImportState({ openUpload: async () => undefined }, send);

    await state.begin("vm_snapshot", new Uint8Array(2 * 1024 * 1024 + 1));
    await state.accept({ transfer_id: 7 });

    expect(state.testState()).toEqual({ importKind: "vm_snapshot", importBytes: 0 });
    expect(send.mock.calls.at(-1)?.[0]).toEqual({
      type: "state_import_commit",
      value: { transfer_id: 7 },
    });
  });
});
