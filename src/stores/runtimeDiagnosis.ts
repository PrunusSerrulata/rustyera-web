import { ref } from "vue";

import { diagnosisArchiveName } from "@/core/diagnosis";
import type { DiagnosisProgress, DiagnosisProgressStage } from "@/core/types";
import type { DiagnosisState } from "@/stores/runtimeState";

export class RuntimeDiagnosisState {
  readonly exporting = ref(false);
  readonly progress = ref<DiagnosisProgress>();
  readonly result = ref("");
  active: DiagnosisState | undefined;

  begin(projectName: string, logs: string, exportedAt: Date): DiagnosisState {
    this.active = {
      name: diagnosisArchiveName(projectName, exportedAt),
      projectName,
      logs,
      exportedAt,
    };
    this.result.value = "";
    this.exporting.value = true;
    this.setProgress("waiting");
    return this.active;
  }

  setProgress(stage: DiagnosisProgressStage, completed = 0, total = 0): void {
    if (!this.exporting.value) return;
    if (
      !Number.isSafeInteger(completed) ||
      !Number.isSafeInteger(total) ||
      completed < 0 ||
      total < 0
    )
      return;
    this.progress.value = {
      stage,
      completed: total > 0 ? Math.min(completed, total) : 0,
      total,
    };
  }

  finish(message: string): void {
    this.active = undefined;
    this.exporting.value = false;
    this.progress.value = undefined;
    this.result.value = message;
  }

  reset(): void {
    this.active = undefined;
    this.exporting.value = false;
    this.progress.value = undefined;
    this.result.value = "";
  }
}
