import { computed, reactive, ref } from "vue";

export type RuntimeTransientStatusOwner = "settings" | "compiled_cache";

interface RuntimeTransientStatus {
  token: number;
  message: string;
  timer?: number;
}

export class RuntimeStatusState {
  readonly base = ref("请选择 Era 项目文件夹");
  readonly current = computed(
    () =>
      this.transient.settings?.message ?? this.transient.compiled_cache?.message ?? this.base.value,
  );

  private readonly transient = reactive<
    Partial<Record<RuntimeTransientStatusOwner, RuntimeTransientStatus>>
  >({});
  private sequence = 0;

  begin(owner: RuntimeTransientStatusOwner, message: string): number {
    this.clear(owner);
    const token = ++this.sequence;
    this.transient[owner] = { token, message };
    return token;
  }

  update(owner: RuntimeTransientStatusOwner, token: number | undefined, message: string): void {
    const active = this.transient[owner];
    if (token == null || active?.token !== token) return;
    active.message = message;
  }

  finish(owner: RuntimeTransientStatusOwner, token: number | undefined, message?: string): void {
    const active = this.transient[owner];
    if (token == null || active?.token !== token) return;
    if (!message) {
      this.clear(owner, token);
      return;
    }
    active.message = message;
    active.timer = window.setTimeout(() => this.clear(owner, token), 2_000);
  }

  clear(owner: RuntimeTransientStatusOwner, token?: number): void {
    const active = this.transient[owner];
    if (!active || (token != null && active.token !== token)) return;
    if (active.timer != null) window.clearTimeout(active.timer);
    delete this.transient[owner];
  }

  appendElapsed(owner: RuntimeTransientStatusOwner, token: number, elapsed: number): void {
    const active = this.transient[owner];
    if (active?.token !== token) return;
    active.message = `${active.message.replace(/ · 已等待 \d+ 秒$/, "")} · 已等待 ${elapsed} 秒`;
  }

  reset(): void {
    this.clear("settings");
    this.clear("compiled_cache");
  }
}
