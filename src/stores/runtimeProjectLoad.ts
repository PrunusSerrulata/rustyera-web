import { ref } from "vue";

import type { ProjectProgress } from "@/core/types";

export class RuntimeProjectLoadState {
  readonly loading = ref(false);
  readonly progress = ref<ProjectProgress>();
  readonly elapsedSeconds = ref(0);
  private acceptingProgress = false;
  private startedAt: number | undefined;
  private elapsedTimer: number | undefined;

  acceptProgress(): void {
    this.acceptingProgress = true;
  }

  begin(): void {
    this.acceptingProgress = true;
    this.loading.value = true;
    this.progress.value = undefined;
    this.startTimer();
  }

  continueBuild(): boolean {
    // Runtime can report project success before the host finishes post-submit work
    // (notably project-font registration). Never reopen an attempt that already settled.
    if (!this.acceptingProgress) return false;
    this.loading.value = true;
    this.startTimer();
    if (
      this.progress.value &&
      this.progress.value.stage !== "importing" &&
      this.progress.value.stage !== "scanning"
    )
      return false;
    this.progress.value = undefined;
    return true;
  }

  transition(): void {
    this.loading.value = true;
    this.progress.value = undefined;
    this.startTimer();
  }

  finish(): void {
    this.acceptingProgress = false;
    this.loading.value = false;
    this.progress.value = undefined;
    this.elapsedSeconds.value = 0;
    this.startedAt = undefined;
    if (this.elapsedTimer != null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  record(progress: ProjectProgress): boolean {
    if (!this.acceptingProgress) return false;
    this.loading.value = true;
    this.startTimer();
    this.progress.value = progress;
    return true;
  }

  private startTimer(): void {
    if (this.startedAt == null) this.startedAt = performance.now();
    if (this.elapsedTimer != null) return;
    this.elapsedTimer = window.setInterval(() => {
      if (this.startedAt == null) return;
      this.elapsedSeconds.value = Math.floor((performance.now() - this.startedAt) / 1000);
    }, 1000);
  }
}

export function normalizeProjectProgress(value: ProjectProgress): ProjectProgress | undefined {
  const progress = {
    stage: value.stage,
    completed: Number(value.completed),
    total: Number(value.total),
    elapsedMs: value.elapsedMs == null ? undefined : Number(value.elapsedMs),
  } satisfies ProjectProgress;
  if (
    !Number.isSafeInteger(progress.completed) ||
    !Number.isSafeInteger(progress.total) ||
    progress.completed < 0 ||
    progress.total < 0
  )
    return undefined;
  return progress;
}
