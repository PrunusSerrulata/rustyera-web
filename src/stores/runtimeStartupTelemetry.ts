import { ref } from "vue";

import type { ProjectOpenMetrics, ProjectProgress, ProjectProgressStage } from "@/core/types";
import { STARTUP_DURATION_BY_STAGE, type StartupTelemetry } from "@/stores/runtimeState";
import { PERFORMANCE_AUDIT_ENABLED, recordPerformanceElapsed } from "@/testing/performanceAudit";

export class RuntimeStartupTelemetryState {
  // Compatibility projection used by loading UI and cache assertions. Performance samples are
  // owned by testing/performanceAudit so loading and steady runtime share one epoch/sequence.
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
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed("loading", "begin", 0, () => ({
        attemptId: this.current.value?.attemptId ?? 0,
        client,
        selection,
      }));
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
    if (PERFORMANCE_AUDIT_ENABLED) {
      const durations: Array<[string, number | null | undefined]> = [
        ["bridge.quick_scan", metrics.quickScanMs],
        ["bridge.cache_read", metrics.cacheReadMs],
        ["bridge.source_read", metrics.sourceReadMs],
        ["bridge.submit", metrics.submitMs],
        ["host.enumerate", metrics.enumerateMs],
        ["host.index_read", metrics.indexReadMs],
        ["host.index_write", metrics.indexWriteMs],
        ["host.stat", metrics.statMs],
        ["host.source_read_decode_hash", metrics.sourceReadDecodeHashMs],
        ["host.cache_read", metrics.cacheReadMs],
        ["host.submission_transfer", metrics.submissionTransferMs ?? metrics.submitMs],
      ];
      for (const [operation, duration] of durations)
        recordPerformanceElapsed("loading", operation, duration, () => ({
          attemptId: telemetry.attemptId,
          client,
        }));
    }
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
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed(
        "loading",
        "milestone.frontend_ready_to_start",
        telemetry.milestones.frontendReadyToStartMs,
        () => ({ attemptId: telemetry.attemptId, scenario: telemetry.scenario }),
      );
  }

  markRuntimeValidationReported(): void {
    const telemetry = this.current.value;
    if (!telemetry || telemetry.milestones.runtimeValidationReportedMs != null) return;
    telemetry.milestones.runtimeValidationReportedMs = this.elapsedMs();
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed(
        "loading",
        "milestone.runtime_validation_reported",
        telemetry.milestones.runtimeValidationReportedMs,
        () => ({ attemptId: telemetry.attemptId }),
      );
  }

  markStartSubmitted(): void {
    const telemetry = this.current.value;
    if (!telemetry || telemetry.milestones.startSubmittedMs != null) return;
    telemetry.milestones.startSubmittedMs = this.elapsedMs();
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed(
        "loading",
        "milestone.start_submitted",
        telemetry.milestones.startSubmittedMs,
        () => ({ attemptId: telemetry.attemptId }),
      );
  }

  completeFirstGamePhase(): void {
    const telemetry = this.current.value;
    if (!telemetry || telemetry.outcome !== "loading") return;
    this.finishProgressStage();
    telemetry.milestones.firstGamePhaseMs ??= this.elapsedMs();
    telemetry.outcome = "success";
    this.startMessageId = undefined;
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed(
        "loading",
        "complete",
        telemetry.milestones.firstGamePhaseMs,
        () => ({
          attemptId: telemetry.attemptId,
          cacheHit: telemetry.cacheHit ?? false,
          scenario: telemetry.scenario,
        }),
      );
  }

  fail(error: unknown): void {
    const telemetry = this.current.value;
    if (!telemetry || telemetry.outcome !== "loading") return;
    this.finishProgressStage();
    telemetry.outcome = "failure";
    telemetry.error = String(error);
    this.startMessageId = undefined;
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed("loading", "failure", this.elapsedMs(), () => ({
        attemptId: telemetry.attemptId,
        error: telemetry.error ?? "unknown",
      }));
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
    if (PERFORMANCE_AUDIT_ENABLED)
      recordPerformanceElapsed("loading", `core.${stage}`, duration, () => ({
        attemptId: telemetry.attemptId,
        source: coreDuration == null ? "frontend_progress" : "runtime_progress",
      }));
    this.progressStage = undefined;
    this.progressStageStartedAtMs = undefined;
  }
}
