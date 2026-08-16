import { ref, type Ref } from "vue";

import type { ProjectConfigurationChange } from "@/core/types";
import type { RuntimeConfigurationState } from "@/stores/runtimeConfiguration";
import type { RuntimeStatusState } from "@/stores/runtimeStatus";

interface RuntimeProjectSettingsContext {
  open: Ref<boolean>;
  configuration: RuntimeConfigurationState;
  status: RuntimeStatusState;
  restart(): Promise<void>;
  logError(message: string): void;
}

export class RuntimeProjectSettingsState {
  readonly busy = ref(false);
  readonly error = ref("");
  private startedAt: number | undefined;
  private elapsedTimer: number | undefined;

  constructor(private readonly context: RuntimeProjectSettingsContext) {}

  async save(changes: ProjectConfigurationChange[], restartAfterApply = false): Promise<void> {
    if (this.busy.value) return;
    this.busy.value = true;
    this.error.value = "";
    const token = this.context.status.begin("settings", "正在保存项目设置…");
    this.startElapsedTimer(token);
    try {
      if (restartAfterApply && this.context.configuration.sessionOnly.value)
        throw new Error("项目文件的会话设置无法通过重启应用");
      const application = changes.length
        ? await this.context.configuration.save(changes, false, token)
        : undefined;
      if (restartAfterApply) {
        this.context.status.clear("settings", token);
        this.context.open.value = false;
        await this.context.restart();
      } else {
        this.context.status.finish(
          "settings",
          token,
          application === "session" ? "会话设置已应用；退出游戏后将丢失" : "项目设置已应用",
        );
      }
    } catch (error) {
      const message = `项目设置未保存：${String(error)}`;
      this.context.status.update("settings", token, message);
      this.context.logError(message);
      this.error.value = message;
    } finally {
      this.busy.value = false;
      this.finishElapsedTimer();
    }
  }

  resetStatus(): void {
    this.finishElapsedTimer();
  }

  private startElapsedTimer(token: number): void {
    this.startedAt = performance.now();
    this.elapsedTimer = window.setInterval(() => {
      if (this.startedAt == null) return;
      const elapsed = Math.floor((performance.now() - this.startedAt) / 1000);
      if (elapsed >= 1) this.context.status.appendElapsed("settings", token, elapsed);
    }, 1000);
  }

  private finishElapsedTimer(): void {
    this.startedAt = undefined;
    if (this.elapsedTimer != null) window.clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }
}
