import { ref, type Ref } from "vue";

import type {
  FrontendBridge,
  Preferences,
  ProjectConfigurationEntry,
  ProjectConfigurationSnapshot,
  ProjectPreferences,
  RuntimeMessage,
} from "@/core/types";

type MessageId = number | bigint;

interface RuntimeClientPreferencesContext {
  bridge: FrontendBridge;
  global: Ref<Preferences>;
  project: Ref<ProjectPreferences>;
  open: Ref<boolean>;
  snapshot(): ProjectConfigurationSnapshot | undefined;
  entries(): ProjectConfigurationEntry[];
  effective(): Preferences;
  send(message: RuntimeMessage): Promise<MessageId>;
  updateConfiguration(value: unknown): void;
  applyHostConfiguration(): Promise<void>;
  applyAudio(value: Preferences): void;
  beginStatus(message: string): number;
  appendElapsed(token: number, seconds: number): void;
  finishStatus(token: number, message: string): void;
  clearStatus(token: number): void;
  logError(message: string): void;
}

interface PendingApplication {
  messageId: string;
  resolve(): void;
  reject(error: Error): void;
}

export class RuntimeClientPreferencesState {
  readonly busy = ref(false);
  readonly error = ref("");
  private pending: PendingApplication | undefined;
  private generation = 0;
  private submitting = false;
  private statusToken: number | undefined;
  private startedAt: number | undefined;
  private elapsedTimer: number | undefined;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly context: RuntimeClientPreferencesContext) {}

  apply(): Promise<void> {
    if (this.pending || this.submitting) return Promise.reject(new Error("客户端偏好操作仍在进行"));
    const snapshot = this.context.snapshot();
    if (!snapshot) return Promise.resolve();
    const eligible = new Set(
      this.context
        .entries()
        .filter((entry) => entry.preference_eligible)
        .map((entry) => entry.code),
    );
    const changes = (settings: Record<string, string>) =>
      Object.entries(settings)
        .filter(([code]) => eligible.has(code))
        .map(([code, value]) => ({ code, value }));
    return new Promise<void>((resolve, reject) => {
      const generation = this.generation;
      this.submitting = true;
      void this.context
        .send({
          type: "apply_client_preferences",
          value: {
            project_revision: snapshot.project_revision,
            global: changes(this.context.global.value.settings),
            project: changes(this.context.project.value.settings),
          },
        })
        .then((messageId) => {
          this.submitting = false;
          if (generation !== this.generation) {
            reject(new Error("客户端偏好操作已取消"));
            return;
          }
          this.pending = { messageId: String(messageId), resolve, reject };
        })
        .catch((error) => {
          this.submitting = false;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async handleApplied(value: any, correlationId: number | bigint | undefined): Promise<boolean> {
    if (!this.pending || this.pending.messageId !== String(correlationId)) return false;
    const pending = this.pending;
    this.pending = undefined;
    try {
      this.context.updateConfiguration(value.configuration);
      await this.context.applyHostConfiguration();
      this.context.applyAudio(this.context.effective());
      pending.resolve();
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  reject(correlationId: number | bigint | undefined, reason: string): boolean {
    if (!this.pending || this.pending.messageId !== String(correlationId)) return false;
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(new Error(reason));
    return true;
  }

  reset(reason = "客户端偏好操作已取消"): void {
    this.generation += 1;
    this.submitting = false;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new Error(reason));
    this.busy.value = false;
    this.error.value = "";
    this.finishTimer();
    if (this.statusToken != null) this.context.clearStatus(this.statusToken);
    this.statusToken = undefined;
  }

  async save(scope: "global" | "project", value: ProjectPreferences): Promise<void> {
    if (this.busy.value) return;
    const generation = this.generation;
    this.busy.value = true;
    this.error.value = "";
    const statusToken = this.context.beginStatus("正在保存客户端偏好…");
    this.statusToken = statusToken;
    this.startedAt = performance.now();
    this.elapsedTimer = window.setInterval(() => {
      if (this.startedAt == null) return;
      const elapsed = Math.floor((performance.now() - this.startedAt) / 1000);
      if (elapsed >= 1) this.context.appendElapsed(statusToken, elapsed);
    }, 1000);
    try {
      if (scope === "global") {
        const saved = await this.persist(() =>
          generation === this.generation
            ? this.context.bridge.savePreferences({
                ...this.context.global.value,
                settings: { ...value.settings },
                imageScale: value.imageScale ?? 1,
                masterVolume: value.masterVolume ?? 1,
                trustProjectFileMetadata: value.trustProjectFileMetadata ?? false,
                interactionAssistMode: value.interactionAssistMode ?? "auto",
              })
            : Promise.reject(new Error("客户端偏好操作已取消")),
        );
        if (generation !== this.generation) return;
        this.context.global.value = saved;
      } else {
        const saved = await this.persist(() =>
          generation === this.generation
            ? this.context.bridge.saveProjectPreferences(value)
            : Promise.reject(new Error("客户端偏好操作已取消")),
        );
        if (generation !== this.generation) return;
        this.context.project.value = saved;
      }
      await this.apply();
      if (generation !== this.generation) return;
      this.context.open.value = false;
      this.context.finishStatus(
        statusToken,
        scope === "global" ? "全局偏好已应用" : "项目偏好已应用",
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.error.value = `偏好未应用：${String(error)}`;
      this.context.finishStatus(statusToken, this.error.value);
      this.context.logError(this.error.value);
    } finally {
      if (generation === this.generation) {
        this.busy.value = false;
        this.finishTimer();
        if (this.statusToken === statusToken) this.statusToken = undefined;
      }
    }
  }

  private finishTimer(): void {
    this.startedAt = undefined;
    if (this.elapsedTimer != null) window.clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }

  private persist<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistenceTail.then(operation, operation);
    this.persistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
