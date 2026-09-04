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
  logWarning(message: string): void;
  logError(message: string): void;
}

type EarlyApplicationReply = { type: "applied"; value: any } | { type: "rejected"; reason: string };

interface PendingApplication {
  generation: number;
  messageId?: string;
  submitting: boolean;
  settling: boolean;
  earlyReplies: Map<string, EarlyApplicationReply>;
  resolve(): void;
  reject(error: Error): void;
}

export class RuntimeClientPreferencesState {
  readonly busy = ref(false);
  readonly error = ref("");
  private pending: PendingApplication | undefined;
  private generation = 0;
  private statusToken: number | undefined;
  private startedAt: number | undefined;
  private elapsedTimer: number | undefined;
  private persistenceTail: Promise<void> = Promise.resolve();
  private applicationTail?: Promise<void>;

  constructor(private readonly context: RuntimeClientPreferencesContext) {}

  apply(): Promise<void> {
    if (!this.applicationTail) {
      const application = this.applyNow();
      this.trackApplication(application);
      return application;
    }
    const generation = this.generation;
    const application = this.applicationTail
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.generation) throw new Error("客户端偏好操作已取消");
        return this.applyNow();
      });
    this.trackApplication(application);
    return application;
  }

  private trackApplication(application: Promise<void>): void {
    const tail = application.catch(() => undefined);
    this.applicationTail = tail;
    void tail.then(() => {
      if (this.applicationTail === tail) this.applicationTail = undefined;
    });
  }

  private applyNow(): Promise<void> {
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
      const pending: PendingApplication = {
        generation,
        submitting: true,
        settling: false,
        earlyReplies: new Map(),
        resolve,
        reject,
      };
      this.pending = pending;
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
          if (generation !== this.generation || this.pending !== pending) return;
          pending.submitting = false;
          pending.messageId = String(messageId);
          const earlyReply = pending.earlyReplies.get(pending.messageId);
          for (const correlation of pending.earlyReplies.keys()) {
            if (correlation !== pending.messageId)
              this.context.logWarning(`忽略了非预期的客户端偏好响应（correlation ${correlation}）`);
          }
          pending.earlyReplies.clear();
          if (earlyReply) void this.finishEarlyReply(pending, earlyReply);
        })
        .catch((error) => {
          if (this.pending !== pending) return;
          pending.submitting = false;
          this.pending = undefined;
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async handleApplied(value: any, correlationId: number | bigint | undefined): Promise<boolean> {
    const pending = this.matchOrDefer(correlationId, { type: "applied", value });
    if (!pending) return false;
    if (pending.messageId == null) return true;
    return this.finishApplied(pending, value);
  }

  private async finishApplied(pending: PendingApplication, value: any): Promise<boolean> {
    if (this.pending !== pending || pending.settling) return false;
    pending.settling = true;
    try {
      this.context.updateConfiguration(value.configuration);
      await this.context.applyHostConfiguration();
      if (this.pending !== pending || pending.generation !== this.generation) return true;
      this.context.applyAudio(this.context.effective());
      this.pending = undefined;
      pending.resolve();
    } catch (error) {
      if (this.pending !== pending) return true;
      this.pending = undefined;
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  reject(correlationId: number | bigint | undefined, reason: string): boolean {
    const pending = this.matchOrDefer(correlationId, { type: "rejected", reason });
    if (!pending) return false;
    if (pending.messageId == null) return true;
    this.pending = undefined;
    pending.reject(new Error(reason));
    return true;
  }

  private matchOrDefer(
    correlationId: number | bigint | undefined,
    reply: EarlyApplicationReply,
  ): PendingApplication | undefined {
    const pending = this.pending;
    if (!pending || pending.settling || correlationId == null) return undefined;
    const correlation = String(correlationId);
    if (pending.messageId != null) return pending.messageId === correlation ? pending : undefined;
    if (!pending.submitting || pending.earlyReplies.has(correlation)) return undefined;
    if (pending.earlyReplies.size >= 8) return undefined;
    pending.earlyReplies.set(correlation, reply);
    return pending;
  }

  private async finishEarlyReply(
    pending: PendingApplication,
    reply: EarlyApplicationReply,
  ): Promise<void> {
    if (reply.type === "applied") {
      await this.finishApplied(pending, reply.value);
      return;
    }
    if (this.pending !== pending) return;
    this.pending = undefined;
    pending.reject(new Error(reply.reason));
  }

  reset(reason = "客户端偏好操作已取消"): void {
    this.generation += 1;
    const pending = this.pending;
    this.pending = undefined;
    pending?.earlyReplies.clear();
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
