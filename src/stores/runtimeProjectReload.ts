import { ref } from "vue";

import type { FrontendBridge, ProjectFontLoadResult, ProjectReloadScope } from "@/core/types";

export class RuntimeProjectReloadState {
  readonly dialogMode = ref<"folder" | "script" | null>(null);
  readonly targetOptions = ref<string[]>([]);
  readonly dialogBusy = ref(false);
  readonly dialogError = ref("");
  private targetRequest = 0;
  private pendingMessageId: string | undefined;

  constructor(private readonly bridge: FrontendBridge) {}

  async openDialog(mode: "folder" | "script", allowed: boolean): Promise<void> {
    if (!allowed) return;
    const request = ++this.targetRequest;
    this.dialogMode.value = mode;
    this.targetOptions.value = [];
    this.dialogError.value = "";
    this.dialogBusy.value = true;
    try {
      const targets = await this.bridge.projectReloadTargets();
      if (!this.isCurrentRequest(request, mode)) return;
      this.targetOptions.value = mode === "folder" ? targets.folders : targets.scripts;
      if (this.targetOptions.value.length === 0) {
        this.dialogError.value =
          mode === "folder" ? "当前项目没有可重新加载的脚本文件夹" : "当前项目没有可重新加载的脚本";
      }
    } catch (error) {
      if (!this.isCurrentRequest(request, mode)) return;
      this.dialogError.value = `无法读取脚本列表：${String(error)}`;
    } finally {
      if (this.isCurrentRequest(request, mode)) this.dialogBusy.value = false;
    }
  }

  closeDialog(): void {
    if (this.dialogBusy.value) return;
    this.clearDialog();
  }

  selectedScope(target: string): ProjectReloadScope | undefined {
    const mode = this.dialogMode.value;
    if (!mode || !this.targetOptions.value.includes(target)) return undefined;
    this.closeDialog();
    return { type: mode, path: target };
  }

  begin(messageId: number | bigint): void {
    this.pendingMessageId = String(messageId);
  }

  matches(correlationId: number | bigint | undefined): boolean {
    return this.pendingMessageId != null && String(correlationId) === this.pendingMessageId;
  }

  get pending(): boolean {
    return this.pendingMessageId != null;
  }

  async finalize(success: boolean): Promise<ProjectFontLoadResult> {
    if (!this.pending) return { fonts: [], errors: [] };
    try {
      return await this.bridge.finalizeProjectReload(success);
    } finally {
      this.pendingMessageId = undefined;
    }
  }

  async failSubmission(): Promise<void> {
    await this.bridge.finalizeProjectReload(false).catch(() => undefined);
    this.pendingMessageId = undefined;
  }

  reset(): void {
    this.clearDialog();
    void this.finalize(false);
  }

  private isCurrentRequest(request: number, mode: "folder" | "script"): boolean {
    return request === this.targetRequest && this.dialogMode.value === mode;
  }

  private clearDialog(): void {
    this.targetRequest += 1;
    this.dialogMode.value = null;
    this.targetOptions.value = [];
    this.dialogBusy.value = false;
    this.dialogError.value = "";
  }
}
