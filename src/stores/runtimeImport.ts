import { blake3 } from "@noble/hashes/blake3.js";

import type { FrontendBridge, RuntimeMessage } from "@/core/types";
import type { RuntimeStartKind } from "@/stores/runtimeState";

export class RuntimeImportState {
  private bytes: Uint8Array | undefined;
  private kind: Exclude<RuntimeStartKind, "new_game"> | undefined;

  constructor(
    private readonly bridge: Pick<FrontendBridge, "openUpload">,
    private readonly send: (message: RuntimeMessage) => Promise<number | bigint>,
  ) {}

  async pickSnapshot(): Promise<void> {
    const bytes = await this.bridge.openUpload();
    if (bytes) await this.begin("vm_snapshot", bytes);
  }

  async begin(kind: Exclude<RuntimeStartKind, "new_game">, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
    this.kind = kind;
    await this.send({
      type: "state_import_begin",
      value: {
        kind,
        total_bytes: bytes.length,
        digest: blake3(bytes),
        artifact_id: null,
      },
    });
  }

  async accept(value: any): Promise<void> {
    if (!this.bytes) return;
    for (let offset = 0; offset < this.bytes.length; offset += 1024 * 1024) {
      await this.send({
        type: "state_import_chunk",
        value: {
          transfer_id: value.transfer_id,
          offset,
          data: this.bytes.slice(offset, offset + 1024 * 1024),
        },
      });
    }
    await this.send({ type: "state_import_commit", value: { transfer_id: value.transfer_id } });
  }

  async ready(value: any): Promise<void> {
    if (!this.kind) throw new Error("状态导入完成但没有待启动的状态类型");
    await this.send({
      type: "start",
      value: { mode: { type: this.kind, transfer_id: value.transfer_id } },
    });
    this.reset();
  }

  testState(): { importKind: string | undefined; importBytes: number } {
    return { importKind: this.kind, importBytes: this.bytes?.length ?? 0 };
  }

  reset(): void {
    this.bytes = undefined;
    this.kind = undefined;
  }
}
