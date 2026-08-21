import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "@/core/types";
import { RuntimeImportState } from "@/stores/runtimeImport";

describe("runtime state import", () => {
  it("returns a selected snapshot without starting its transfer", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const send = vi.fn<(message: RuntimeMessage) => Promise<number | bigint>>(async () => 1);
    const state = new RuntimeImportState({ openUpload: async () => bytes }, send);

    await expect(state.pickSnapshot()).resolves.toBe(bytes);
    expect(send).not.toHaveBeenCalled();
  });

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

  it("releases snapshot bytes when begin submission fails", async () => {
    const failure = new Error("begin failed");
    const send = vi
      .fn<(message: RuntimeMessage) => Promise<number | bigint>>()
      .mockRejectedValue(failure);
    const state = new RuntimeImportState({ openUpload: async () => undefined }, send);

    await expect(state.begin("vm_snapshot", Uint8Array.of(1, 2, 3))).rejects.toBe(failure);

    expect(state.testState()).toEqual({ importKind: undefined, importBytes: 0 });
  });

  it.each(["state_import_chunk", "state_import_commit"] as const)(
    "releases snapshot bytes when %s submission fails",
    async (failedType) => {
      const failure = new Error(`${failedType} failed`);
      let nextId = 1;
      const send = vi.fn<(message: RuntimeMessage) => Promise<number | bigint>>(async (message) => {
        if (message.type === failedType) throw failure;
        return nextId++;
      });
      const state = new RuntimeImportState({ openUpload: async () => undefined }, send);

      await state.begin("vm_snapshot", new Uint8Array(1024 * 1024 + 1));
      await expect(state.accept({ transfer_id: 7 })).rejects.toBe(failure);

      expect(state.testState()).toEqual({ importKind: undefined, importBytes: 0 });
    },
  );

  it("releases snapshot bytes only for a matching asynchronous command rejection", async () => {
    const send = vi.fn<(message: RuntimeMessage) => Promise<number | bigint>>(async () => 41);
    const state = new RuntimeImportState({ openUpload: async () => undefined }, send);
    await state.begin("vm_snapshot", Uint8Array.of(1, 2, 3));

    expect(state.reject(99)).toBe(false);
    expect(state.testState()).toEqual({ importKind: "vm_snapshot", importBytes: 3 });
    expect(state.reject(41)).toBe(true);
    expect(state.testState()).toEqual({ importKind: undefined, importBytes: 0 });
  });

  it("clears import ownership when starting the restored state fails", async () => {
    const failure = new Error("start failed");
    const send = vi.fn<(message: RuntimeMessage) => Promise<number | bigint>>(async (message) => {
      if (message.type === "start") throw failure;
      return 1;
    });
    const state = new RuntimeImportState({ openUpload: async () => undefined }, send);
    await state.begin("vm_snapshot", Uint8Array.of(1));
    await state.accept({ transfer_id: 7 });

    await expect(state.ready({ transfer_id: 7 })).rejects.toBe(failure);

    expect(state.testState()).toEqual({ importKind: undefined, importBytes: 0 });
  });
});
