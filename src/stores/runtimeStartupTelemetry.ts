import { ref } from "vue";

import type { ProjectOpenMetrics, ProjectProgress, ProjectProgressStage } from "@/core/types";
import { STARTUP_DURATION_BY_STAGE, type StartupTelemetry } from "@/stores/runtimeState";

export class RuntimeStartupTelemetryState {
  readonly current = ref<StartupTelemetry>();
  startMessageId?: string;

  private attemptSequence = 0;
  private progressStage?: ProjectProgressStage;
  private progressStageStartedAtMs?: number;
  private coreProgressStartedAtMs: Partial<Record<ProjectProgressStage, number>> = {};
  private coreProgressDurations: Partial<Record<ProjectProgressStage, number>> = {};

  begin(submittedAtMs: number, selection: "directory" | "file", client: "browser" | "tauri"): void {
    this.progressStage = undefined;
    this.progressStageStartedAtMs = undefined;
    this.coreProgressStartedAtMs = {};
    this.coreProgressDurations = {};
    this.startMessageId = undefined;
    this.current.value = {
      attemptId: ++this.attemptSequence,
      client,
      scenario: selection === "file" ? "project_file" : "cold",
      submittedAtMs,
      bridge: { quickScanMs: null, cacheReadMs: null, sourceReadMs: null, submitMs: null },
      durations: {
        enumerateMs: null,
        indexReadMs: null,
        indexWriteMs: null,
        statMs: null,
        sourceReadDecodeHashMs: null,
        cacheReadMs: null,
        submissionTransferMs: null,
        normalizeMs: null,
        csvMs: null,
        cacheParseMs: null,
        cacheDecodeMs: null,
        cacheValidateMs: null,
        parseMs: null,
        analyzeMs: null,
        compileMs: null,
        finalizeMs: null,
        validateMs: null,
        prepareMs: null,
      },
      sourceIndex: { present: null, trusted: null, reusedFiles: null, hashedFiles: null },
      wasmMode: null,
      wasmMemory: { constrained: null, peakBytes: null, stages: {} },
      observedStages: {},
      milestones: {
        runtimeValidationReportedMs: null,
        frontendReadyToStartMs: null,
        startSubmittedMs: null,
        firstGamePhaseMs: null,
      },
      cacheHit: null,
      outcome: "loading",
      error: null,
    };
  }

  applyBridgeMetrics(metrics: ProjectOpenMetrics, client: "browser" | "tauri"): void {
    const telemetry = this.current.value;
    if (!telemetry) return;
    telemetry.bridge = {
      quickScanMs: metrics.quickScanMs,
      cacheReadMs: metrics.cacheReadMs,
      sourceReadMs: metrics.sourceReadMs,
      submitMs: metrics.submitMs,
    };
    telemetry.durations.enumerateMs = metrics.enumerateMs ?? null;
    telemetry.durations.indexReadMs = metrics.indexReadMs ?? null;
    telemetry.durations.indexWriteMs = metrics.indexWriteMs ?? null;
    telemetry.durations.statMs = metrics.statMs ?? null;
    telemetry.durations.sourceReadDecodeHashMs = metrics.sourceReadDecodeHashMs ?? null;
    telemetry.durations.cacheReadMs = metrics.cacheReadMs;
    telemetry.durations.submissionTransferMs = metrics.submissionTransferMs ?? metrics.submitMs;
    telemetry.sourceIndex = {
      present: metrics.sourceIndexPresent ?? null,
      trusted: metrics.sourceIndexTrusted ?? null,
      reusedFiles: metrics.sourceIndexReusedFiles ?? null,
      hashedFiles: metrics.sourceIndexHashedFiles ?? null,
    };
    telemetry.wasmMode = metrics.wasmMode ?? (client === "tauri" ? null : "single");
    telemetry.wasmMemory.constrained = metrics.memoryConstrained ?? null;
  }

  elapsedMs(): number {
    return performance.now() - (this.current.value?.submittedAtMs ?? performance.now());
  }

  completeFrontendReadiness(): void {
    const telemetry = this.current.value;
    if (!telemetry) return;
    telemetry.cacheHit ??= false;
    if (telemetry.scenario !== "project_file") {
      telemetry.scenario = telemetry.cacheHit ? "warm" : "cold";
    }
    telemetry.milestones.frontendReadyToStartMs = this.elapsedMs();
  }

  fail(error: unknown): void {
    const telemetry = this.current.value;
    if (!telemetry || telemetry.outcome !== "loading") return;
    this.finishProgressStage();
    telemetry.outcome = "failure";
    telemetry.error = String(error);
    this.startMessageId = undefined;
  }

  recordProgress(progress: ProjectProgress): void {
    const telemetry = this.current.value;
    if (!telemetry) return;
    const { stage } = progress;
    if (progress.memoryBytes != null) {
      telemetry.wasmMemory.peakBytes = Math.max(
        telemetry.wasmMemory.peakBytes ?? 0,
        progress.memoryBytes,
      );
      telemetry.wasmMemory.stages[stage] = Math.max(
        telemetry.wasmMemory.stages[stage] ?? 0,
        progress.memoryBytes,
      );
    }
    if (Number.isFinite(progress.elapsedMs)) {
      if (progress.completed === 0) this.coreProgressStartedAtMs[stage] = progress.elapsedMs;
      const started = this.coreProgressStartedAtMs[stage];
      if (started != null && progress.completed >= progress.total) {
        const duration = Math.max(0, progress.elapsedMs! - started);
        this.coreProgressDurations[stage] = duration;
        telemetry.observedStages[stage] = duration;
        const durationField = STARTUP_DURATION_BY_STAGE[stage];
        if (durationField) telemetry.durations[durationField] = duration;
      }
    }
    if (this.progressStage === stage) return;
    this.finishProgressStage();
    this.progressStage = stage;
    this.progressStageStartedAtMs = this.elapsedMs();
  }

  recordWasmMemory(memoryBytes: number | undefined): void {
    const telemetry = this.current.value;
    if (
      !telemetry ||
      telemetry.outcome !== "loading" ||
      memoryBytes == null ||
      !Number.isSafeInteger(memoryBytes) ||
      memoryBytes < 0
    )
      return;
    telemetry.wasmMemory.peakBytes = Math.max(telemetry.wasmMemory.peakBytes ?? 0, memoryBytes);
  }

  finishProgressStage(): void {
    const telemetry = this.current.value;
    const stage = this.progressStage;
    const startedAt = this.progressStageStartedAtMs;
    if (!telemetry || !stage || startedAt == null) return;
    const coreDuration = this.coreProgressDurations[stage];
    const duration = coreDuration ?? this.elapsedMs() - startedAt;
    telemetry.observedStages[stage] =
      coreDuration ?? (telemetry.observedStages[stage] ?? 0) + duration;
    const durationField = STARTUP_DURATION_BY_STAGE[stage];
    if (durationField) {
      telemetry.durations[durationField] =
        coreDuration ?? (telemetry.durations[durationField] ?? 0) + duration;
    }
    this.progressStage = undefined;
    this.progressStageStartedAtMs = undefined;
  }
}
