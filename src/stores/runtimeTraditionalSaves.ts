import { ref } from "vue";

import { saveSlotFileName } from "@/core/runtimeSupport";
import type { TraditionalSaveAccess, TraditionalSaveSlot } from "@/core/types";

export class RuntimeTraditionalSaveState {
  readonly mode = ref<"export" | "import" | null>(null);
  readonly slots = ref<TraditionalSaveSlot[]>([]);
  readonly importName = ref("");
  readonly busy = ref(false);
  readonly error = ref("");
  readonly overwriteSlot = ref<number | null>(null);
  private importBytes: Uint8Array | undefined;

  constructor(
    private readonly access: TraditionalSaveAccess | undefined,
    private readonly setStatus: (message: string) => void,
  ) {}

  async open(mode: "export" | "import", allowed: boolean): Promise<void> {
    if (!this.access || !allowed) return;
    this.reset();
    this.mode.value = mode;
    this.busy.value = true;
    try {
      this.slots.value = await this.access.listSlots();
    } catch (error) {
      this.error.value = `无法读取存档槽位：${String(error)}`;
    } finally {
      this.busy.value = false;
    }
  }

  close(): void {
    if (this.busy.value) return;
    this.reset();
  }

  reset(): void {
    this.mode.value = null;
    this.slots.value = [];
    this.importName.value = "";
    this.importBytes = undefined;
    this.busy.value = false;
    this.error.value = "";
    this.overwriteSlot.value = null;
  }

  async pickImport(): Promise<void> {
    if (!this.access || this.mode.value !== "import" || this.busy.value) return;
    this.error.value = "";
    this.busy.value = true;
    try {
      const selected = await this.access.pickImport();
      if (!selected) return;
      this.importName.value = selected.name;
      this.importBytes = selected.bytes;
      this.overwriteSlot.value = null;
    } catch (error) {
      this.error.value = `选择存档失败：${String(error)}`;
    } finally {
      this.busy.value = false;
    }
  }

  async confirm(slot: number): Promise<void> {
    const selected = this.slots.value.find((entry) => entry.slot === slot);
    if (!this.access || !selected || this.busy.value) return;
    this.error.value = "";
    this.busy.value = true;
    try {
      if (this.mode.value === "export") {
        if (!selected.occupied) throw new Error("所选存档槽位为空");
        await this.access.exportSlot(slot);
        this.setStatus(`已导出 ${saveSlotFileName(slot)}`);
        this.busy.value = false;
        this.close();
        return;
      }
      if (this.mode.value !== "import") return;
      if (!this.importBytes) throw new Error("请先选择要导入的 .sav 存档文件");
      if (!/\.sav$/i.test(this.importName.value)) throw new Error("请选择 .sav 存档文件");
      await this.access.inspect(this.importBytes);
      this.slots.value = await this.access.listSlots();
      if (this.slots.value.find((entry) => entry.slot === slot)?.occupied) {
        this.overwriteSlot.value = slot;
        return;
      }
      await this.writeImport(slot);
    } catch (error) {
      this.error.value = `导入存档失败：${String(error)}`;
    } finally {
      this.busy.value = false;
    }
  }

  cancelOverwrite(): void {
    this.overwriteSlot.value = null;
  }

  async confirmOverwrite(): Promise<void> {
    const slot = this.overwriteSlot.value;
    if (slot == null || this.busy.value) return;
    this.busy.value = true;
    this.error.value = "";
    try {
      await this.writeImport(slot);
    } catch (error) {
      this.error.value = `导入存档失败：${String(error)}`;
    } finally {
      this.busy.value = false;
    }
  }

  private async writeImport(slot: number): Promise<void> {
    if (!this.access || !this.importBytes) throw new Error("没有可导入的存档文件");
    await this.access.writeSlot(slot, this.importBytes);
    this.setStatus(`已导入 ${saveSlotFileName(slot)}`);
    this.busy.value = false;
    this.close();
  }
}
