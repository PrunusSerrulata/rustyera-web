// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { sha256Bytes } from "@/core/sqlProtocol";
import { SqlStorage } from "@/platform/sqlStorage";

const engine = vi.hoisted(() => ({ libVersion: "3.53.0" }));
const openDatabase = vi.hoisted(() => vi.fn());
vi.mock("@sqlite.org/sqlite-wasm", () => ({
  default: async () => ({ version: engine, oo1: { DB: openDatabase } }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each(["3.53.0", "3.53.2", "9.0.0"])(
  "rejects actual engine %s before opening a database",
  async (version) => {
    engine.libVersion = version;
    const worker = {
      onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", worker);
    await import("@/platform/sql.worker");
    const handle = { serviceEpoch: 1n, id: 1n };
    await worker.onmessage!({
      data: {
        id: 1,
        type: "execute",
        value: {
          request: {
            provider: handle,
            operation: {
              kind: "open",
              connection: handle,
              logicalName: "db",
              identity: { source: { kind: "memory" }, sqliteVersion: "3.53.4", formatVersion: 1 },
              revision: { kind: "current" },
            },
          },
          persistent: false,
          reusableScalarResults: false,
          readerRowResults: false,
        },
      },
    });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      id: 1,
      type: "error",
      error: `SQLite version mismatch: ${version}`,
    });
    expect(openDatabase).not.toHaveBeenCalled();

    const seed = new Uint8Array([1, 2, 3]);
    const bridge = { readResource: vi.fn(async () => seed), handleStorage: vi.fn() };
    const storage = new SqlStorage(bridge as never);
    await expect(
      storage.openResource(
        "plugins/qol_data.db",
        sha256Bytes(seed),
        { kind: "current" },
        async (value) => {
          await worker.onmessage!({ data: { id: 2, type: "validate", value } });
          const reply = worker.postMessage.mock.calls.at(-1)![0];
          if (reply.type === "error") throw new Error(reply.error);
        },
      ),
    ).rejects.toThrow(`SQLite version mismatch: ${version}`);
    expect(openDatabase).not.toHaveBeenCalled();
    expect(bridge.handleStorage).not.toHaveBeenCalled();
  },
);
