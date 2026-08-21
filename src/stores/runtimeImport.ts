import { blake3 } from "@noble/hashes/blake3.js";

import type { FrontendBridge, RuntimeMessage } from "@/core/types";
import type { RuntimeStartKind } from "@/stores/runtimeState";

export class RuntimeImportState {
  private bytes: Uint8Array | undefined;
  private kind: Exclude<RuntimeStartKind, "new_game"> | undefined;
  private readonly commandMessageIds = new Set<string>();

  constructor(
    private readonly bridge: Pick<FrontendBridge, "openUpload">,
    private readonly send: (message: RuntimeMessage) => Promise<number | bigint>,
  ) {}

  async pickSnapshot(): Promise<Uint8Array | undefined> {
    return this.bridge.openUpload();
  }

  async begin(kind: Exclude<RuntimeStartKind, "new_game">, bytes: Uint8Array): Promise<void> {
    this.reset();
    this.bytes = bytes;
    this.kind = kind;
    try {
      await this.sendTracked({
        type: "state_import_begin",
        value: {
          kind,
          total_bytes: bytes.length,
          digest: blake3(bytes),
          artifact_id: null,
        },
      });
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  async accept(value: any): Promise<void> {
    if (!this.bytes) return;
    try {
      for (let offset = 0; offset < this.bytes.length; offset += 1024 * 1024) {
        await this.sendTracked({
          type: "state_import_chunk",
          value: {
            transfer_id: value.transfer_id,
            offset,
            data: this.bytes.slice(offset, offset + 1024 * 1024),
          },
        });
      }
      await this.sendTracked({
        type: "state_import_commit",
        value: { transfer_id: value.transfer_id },
      });
      // The Runtime owns the completed transfer after commit. Drop the browser-side copy before
      // snapshot startup, where the old VM, serialized snapshot, and restored VM can otherwise
      // overlap long enough for iOS WebKit to terminate and reload the page under memory pressure.
      this.bytes = undefined;
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  async ready(value: any): Promise<void> {
    if (!this.kind) throw new Error("状态导入完成但没有待启动的状态类型");
    try {
      await this.sendTracked({
        type: "start",
        value: { mode: { type: this.kind, transfer_id: value.transfer_id } },
      });
    } finally {
      this.reset();
    }
  }

  reject(correlationId: number | bigint | null | undefined): boolean {
    if (correlationId == null || !this.commandMessageIds.has(String(correlationId))) return false;
    this.reset();
    return true;
  }

  testState(): { importKind: string | undefined; importBytes: number } {
    return { importKind: this.kind, importBytes: this.bytes?.length ?? 0 };
  }

  reset(): void {
    this.bytes = undefined;
    this.kind = undefined;
    this.commandMessageIds.clear();
  }

  private async sendTracked(message: RuntimeMessage): Promise<void> {
    const messageId = await this.send(message);
    this.commandMessageIds.add(String(messageId));
  }
}
