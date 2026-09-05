export class RuntimeTestEnvironment {
  clock: Date | undefined;
  private entropyState: bigint | undefined;
  private monotonicOrigin: { frontendMs: number; runtimeNs: number } | undefined;
  private lastTimeAdvanceNs: number | undefined;

  configure(
    clock: string | null | undefined,
    seed: number | bigint | string | undefined,
    startNs?: number,
  ) {
    this.clock = clock === null ? undefined : new Date(clock ?? "2026-01-01T00:00:00Z");
    if (this.clock && Number.isNaN(this.clock.getTime()))
      throw new Error("测试 clock 不是有效日期");
    this.entropyState = BigInt(seed ?? 1) || 1n;
    this.monotonicOrigin = {
      frontendMs: performance.now(),
      runtimeNs: startNs ?? 1_000_000,
    };
  }

  nextEntropy(): bigint | undefined {
    if (this.entropyState == null) return undefined;
    this.entropyState =
      (this.entropyState * 6364136223846793005n + 1442695040888963407n) & 0xffff_ffff_ffff_ffffn;
    return this.entropyState;
  }

  sampleMonotonic(): number {
    const frontendMs = performance.now();
    if (!this.monotonicOrigin) return Math.round(frontendMs * 1_000_000);
    return Math.round(
      this.monotonicOrigin.runtimeNs +
        Math.max(0, frontendMs - this.monotonicOrigin.frontendMs) * 1_000_000,
    );
  }

  shouldAdvanceTime(now: number, intervalNs: number): boolean {
    if (this.lastTimeAdvanceNs != null && now - this.lastTimeAdvanceNs < intervalNs) return false;
    this.lastTimeAdvanceNs = now;
    return true;
  }

  recordTimeAdvance(now: number): void {
    this.lastTimeAdvanceNs = now;
  }

  resetTimeAdvance(): void {
    this.lastTimeAdvanceNs = undefined;
  }
}
