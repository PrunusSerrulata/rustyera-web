import { blake3 } from "@noble/hashes/blake3.js";
import { computed, ref } from "vue";

import {
  clientConfigurationEntries,
  equalConfigurationIdentity,
  parsePreparedConfiguration,
  parseProjectConfiguration,
  prepareConfigurationUpdate,
} from "@/core/configuration";
import type {
  FrontendBridge,
  ProjectConfigurationChange,
  ProjectConfigurationSnapshot,
  RuntimeMessage,
} from "@/core/types";
import type { PendingConfigurationUpdate } from "@/stores/runtimeState";

import {
  configurationBoolean,
  configurationValue,
  sameMessageId,
} from "./runtimeConfiguration/values";

interface RuntimeConfigurationContext {
  bridge: FrontendBridge;
  send(message: RuntimeMessage): Promise<number | bigint>;
  setVolume(volume: number): void;
  log(level: "warning" | "error", message: string): void;
  updateSettingsStatus(token: number | undefined, message: string): void;
  viewportChrome(): { width: number; height: number };
  refreshCompiledCache(): Promise<void>;
}

export class RuntimeConfigurationState {
  readonly snapshot = ref<ProjectConfigurationSnapshot | null>(null);
  readonly profileValid = ref(true);
  readonly migrationFailed = ref(false);
  readonly writable = ref(false);
  readonly entries;
  readonly readOnly;
  readonly sessionOnly;
  readonly restartPending;
  private pending: PendingConfigurationUpdate | undefined;

  constructor(private readonly context: RuntimeConfigurationContext) {
    this.entries = computed(() =>
      clientConfigurationEntries(this.snapshot.value, context.bridge.kind),
    );
    this.readOnly = computed(
      () =>
        this.snapshot.value != null &&
        (!this.writable.value || !this.profileValid.value || this.migrationFailed.value),
    );
    this.sessionOnly = computed(
      () => this.snapshot.value != null && !this.writable.value && this.profileValid.value,
    );
    this.restartPending = computed(() => this.snapshot.value?.restart_pending ?? false);
  }

  refreshWritable(): void {
    this.writable.value = this.context.bridge.projectConfigurationWritable();
  }

  acceptProfile(profile: unknown): boolean {
    this.profileValid.value = profile === this.context.bridge.kind;
    return this.profileValid.value;
  }

  update(value: unknown): void {
    if (value == null) {
      this.snapshot.value = null;
      this.migrationFailed.value = false;
      this.context.setVolume(1);
      return;
    }
    try {
      this.snapshot.value = parseProjectConfiguration(value);
      if (this.snapshot.value.generated_source == null) this.migrationFailed.value = false;
      const volume = Number(this.value("AudioVolume") ?? 100);
      this.context.setVolume(Number.isFinite(volume) ? volume / 100 : 1);
    } catch (error) {
      this.snapshot.value = null;
      this.context.log("error", `项目配置响应无效：${String(error)}`);
    }
  }

  async persistGenerated(): Promise<void> {
    const snapshot = this.snapshot.value;
    const source = snapshot?.generated_source;
    if (snapshot == null || source == null || !this.writable.value) return;
    try {
      await this.context.bridge.writeProjectConfiguration(snapshot.source_digest, source);
      this.migrationFailed.value = true;
      if (this.pending == null) {
        const { completion } = await this.beginUpdate([], true);
        void completion.catch((error) => {
          this.migrationFailed.value = true;
          this.context.log("error", `确认 reraconfig.toml 迁移失败：${String(error)}`);
        });
      }
    } catch (error) {
      this.migrationFailed.value = true;
      this.context.log("error", `迁移 reraconfig.toml 失败：${String(error)}`);
      throw error;
    }
  }

  value(code: string): string | undefined {
    return configurationValue(this.snapshot.value, code);
  }

  boolean(code: string, fallback: boolean): boolean {
    return configurationBoolean(this.snapshot.value, code, fallback);
  }

  async save(
    changes: ProjectConfigurationChange[],
    automatic = false,
    statusToken?: number,
  ): Promise<"persistent" | "session"> {
    const update = await this.beginUpdate(changes, automatic, statusToken);
    await update.completion;
    return update.application;
  }

  async beginUpdate(
    changes: ProjectConfigurationChange[],
    automatic: boolean,
    statusToken?: number,
  ): Promise<{ completion: Promise<void>; application: "persistent" | "session" }> {
    const snapshot = this.snapshot.value;
    if (!snapshot || !this.profileValid.value)
      throw new Error(!snapshot ? "项目配置尚未加载" : "当前项目配置不可修改");
    const sessionOnly = !this.writable.value;
    if (
      sessionOnly &&
      changes.some((change) => {
        const entry = this.entries.value.find((item) => item.code === change.code);
        return !entry || entry.fixed || entry.application !== "hot";
      })
    )
      throw new Error("项目文件仅支持当前会话内即时生效的设置");
    if (this.pending) throw new Error("项目配置正在保存，请稍候");
    const prepareMessageId = await this.context.send({
      type: "prepare_configuration_update",
      value: prepareConfigurationUpdate(snapshot, changes),
    });
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((fulfilled, rejected) => {
      resolve = fulfilled;
      reject = rejected;
    });
    this.pending = {
      stage: "preparing",
      prepareMessageId,
      snapshot,
      changedCodes: changes.map((change) => change.code),
      sessionOnly,
      automatic,
      statusToken,
      resolve,
      reject,
    };
    if (!automatic) this.context.updateSettingsStatus(statusToken, "正在验证项目配置…");
    return { completion, application: sessionOnly ? "session" : "persistent" };
  }

  async handlePrepared(value: any, correlationId?: number | bigint): Promise<void> {
    const pending = this.pending;
    if (pending?.stage !== "preparing" || !sameMessageId(pending.prepareMessageId, correlationId)) {
      this.context.log("warning", "忽略了过期的项目配置保存响应");
      return;
    }
    let writeError: unknown;
    try {
      const prepared = parsePreparedConfiguration(value);
      if (!equalConfigurationIdentity(prepared, pending.snapshot))
        throw new Error("项目配置在保存前已经变化");
      const contentsDigest = blake3(new TextEncoder().encode(prepared.contents));
      if (
        contentsDigest.length !== prepared.prepared_source_digest.length ||
        !contentsDigest.every((byte, index) => byte === prepared.prepared_source_digest[index])
      )
        throw new Error("Runtime 返回的项目配置摘要无效");
      if (pending.sessionOnly && prepared.restart_required)
        throw new Error("项目文件仅支持当前会话内即时生效的设置");
      if (!pending.sessionOnly)
        await this.context.bridge.writeProjectConfiguration(
          prepared.expected_source_digest,
          prepared.contents,
        );
    } catch (error) {
      writeError = error;
    }
    await this.beginFinalization(pending, writeError == null ? "commit" : "abort", writeError);
    if (writeError == null && !pending.automatic && this.pending?.stage === "finalizing")
      this.context.updateSettingsStatus(pending.statusToken, "正在应用项目配置…");
  }

  async handleCommitted(value: any, correlationId?: number | bigint): Promise<void> {
    const pending = this.pending;
    if (
      pending?.stage !== "finalizing" ||
      !sameMessageId(pending.finalizeMessageId, correlationId)
    ) {
      this.context.log("warning", "忽略了过期的项目配置提交响应");
      return;
    }
    this.pending = undefined;
    this.update(value.configuration);
    if (pending.outcome === "abort") {
      const error = new Error(`保存项目配置失败：${String(pending.writeError)}`);
      this.context.log("error", error.message);
      pending.reject(error);
      return;
    }
    if (!pending.automatic) {
      try {
        await this.context.bridge.applyProjectConfiguration(
          this.entries.value,
          this.context.viewportChrome(),
          pending.changedCodes,
        );
      } catch (error) {
        this.context.log("warning", `客户端项目配置应用失败：${String(error)}`);
      }
      this.context.updateSettingsStatus(pending.statusToken, "正在刷新项目设置缓存…");
      if (!pending.sessionOnly) await this.context.refreshCompiledCache();
    }
    pending.resolve();
  }

  reject(correlationId: number | bigint | undefined, message: string): void {
    const pending = this.pending;
    if (!pending || correlationId == null) return;
    const messageId =
      pending.stage === "preparing" ? pending.prepareMessageId : pending.finalizeMessageId;
    if (!sameMessageId(messageId, correlationId)) return;
    this.pending = undefined;
    pending.reject(new Error(`项目配置未保存：${message}`));
  }

  reset(): void {
    this.snapshot.value = null;
    this.writable.value = false;
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(new Error("项目会话已重置，配置事务已取消"));
  }

  private async beginFinalization(
    pending: Extract<PendingConfigurationUpdate, { stage: "preparing" }>,
    outcome: "commit" | "abort",
    writeError?: unknown,
  ): Promise<void> {
    try {
      const finalizeMessageId = await this.context.send({
        type: "finalize_configuration_update",
        value: { preparation_message_id: pending.prepareMessageId, outcome },
      });
      if (this.pending !== pending) return;
      this.pending = {
        ...pending,
        stage: "finalizing",
        finalizeMessageId,
        outcome,
        writeError,
      };
    } catch (error) {
      if (this.pending === pending) this.pending = undefined;
      pending.reject(new Error(`项目配置事务无法完成：${String(error)}`));
    }
  }
}
