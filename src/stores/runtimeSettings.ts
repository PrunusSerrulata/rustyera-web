import { ref, type Ref } from "vue";

import type { Preferences, ProjectConfigurationChange } from "@/core/types";
import type { RuntimeConfigurationState } from "@/stores/runtimeConfiguration";
import type { RuntimeStatusState } from "@/stores/runtimeStatus";

interface RuntimeSettingsContext {
  preferences: Ref<Preferences>;
  preferencesOpen: Ref<boolean>;
  configuration: RuntimeConfigurationState;
  status: RuntimeStatusState;
  savePreferences(value: Preferences): Promise<Preferences>;
  applyAudioPreferences(value: Preferences): void;
  restart(): Promise<void>;
  logError(message: string): void;
}

export class RuntimeSettingsState {
  readonly preview = ref<Preferences | null>(null);
  readonly busy = ref(false);
  readonly error = ref("");
  private startedAt: number | undefined;
  private elapsedTimer: number | undefined;

  constructor(private readonly context: RuntimeSettingsContext) {}

  async save(
    value: Preferences,
    changes: ProjectConfigurationChange[] = [],
    restartAfterApply = false,
  ): Promise<void> {
    if (this.busy.value) return;
    this.busy.value = true;
    this.error.value = "";
    const statusToken = this.context.status.begin("settings", "正在保存设置…");
    this.startElapsedTimer(statusToken);
    let projectApplication: "persistent" | "session" | undefined;
    let preferencesSaved = false;
    try {
      if (changes.length) {
        if (restartAfterApply && this.context.configuration.sessionOnly.value)
          throw new Error("项目文件的会话设置无法通过重启应用");
        projectApplication = await this.context.configuration.save(changes, false, statusToken);
      }
      this.context.status.update("settings", statusToken, "正在保存客户端偏好…");
      this.context.preferences.value = await this.context.savePreferences(value);
      preferencesSaved = true;
      this.preview.value = null;
      this.context.applyAudioPreferences(this.context.preferences.value);
      if (restartAfterApply) {
        this.context.status.clear("settings", statusToken);
        this.context.preferencesOpen.value = false;
        await this.context.restart();
      } else {
        this.context.status.finish(
          "settings",
          statusToken,
          projectApplication === "session" ? "会话设置已应用；退出游戏后将丢失" : "设置已应用",
        );
      }
    } catch (error) {
      const message = preferencesSaved
        ? `设置已保存，但重新启动失败：${String(error)}`
        : projectApplication === "session"
          ? `会话设置已应用（退出游戏后将丢失），但客户端偏好保存失败：${String(error)}`
          : projectApplication === "persistent"
            ? `项目设置已应用，但客户端偏好保存失败：${String(error)}`
            : `设置未保存：${String(error)}`;
      this.context.status.update("settings", statusToken, message);
      this.context.logError(message);
      this.error.value = message;
    } finally {
      this.busy.value = false;
      this.finishElapsedTimer();
    }
  }

  showPreview(value: Preferences | null): void {
    this.preview.value = value;
    this.context.applyAudioPreferences(value ?? this.context.preferences.value);
  }

  resetStatus(): void {
    this.finishElapsedTimer();
  }

  private startElapsedTimer(statusToken: number): void {
    this.startedAt = performance.now();
    this.elapsedTimer = window.setInterval(() => {
      if (this.startedAt == null) return;
      const elapsed = Math.floor((performance.now() - this.startedAt) / 1000);
      if (elapsed < 1) return;
      this.context.status.appendElapsed("settings", statusToken, elapsed);
    }, 1000);
  }

  private finishElapsedTimer(): void {
    this.startedAt = undefined;
    if (this.elapsedTimer != null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }
}
