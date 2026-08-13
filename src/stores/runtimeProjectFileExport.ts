import { ref } from "vue";

import type { ProjectProgress } from "@/core/types";

/** Own the visible project-file export state without taking ownership of its transfer object. */
export class RuntimeProjectFileExportState {
  readonly exporting = ref(false);
  readonly progress = ref<ProjectProgress>();
  private resumeCacheAfterExport = false;

  begin(): void {
    this.exporting.value = true;
    this.progress.value = { stage: "scanning", completed: 0, total: 0 };
  }

  beginPackaging(total: number): void {
    this.progress.value = { stage: "packaging", completed: 0, total };
  }

  updatePackaging(completed: number, total: number): void {
    this.progress.value = { stage: "packaging", completed, total };
  }

  setProgress(progress: ProjectProgress): void {
    this.progress.value = progress;
  }

  resumeCacheWhenFinished(): void {
    this.resumeCacheAfterExport = true;
  }

  finish(): boolean {
    this.exporting.value = false;
    this.progress.value = undefined;
    const resumeCache = this.resumeCacheAfterExport;
    this.resumeCacheAfterExport = false;
    return resumeCache;
  }

  scheduleRetry(callback: () => void): void {
    window.setTimeout(callback, 50);
  }
}
