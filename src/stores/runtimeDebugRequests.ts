interface PendingDebugRequest {
  grant: any;
  commandType: string | undefined;
  resolve?: (value: any) => void;
  reject?: (error: Error) => void;
  timer?: number;
}

export class RuntimeDebugRequestState {
  pausePending = false;
  pauseWanted = false;
  surfacePauseActive = false;
  surfaceResumePending = false;
  grantRefreshNeeded = false;
  private variableRefreshId = 0;
  private readonly pending = new Map<string, PendingDebugRequest>();

  register(messageId: number | bigint, grant: any, commandType: string | undefined): void {
    this.pending.set(String(messageId), { grant, commandType });
  }

  wait(
    messageId: number | bigint,
    grant: any,
    commandType: string | undefined,
    timeoutMs: number,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const key = String(messageId);
      const timer = window.setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`debug ${commandType ?? "request"} 超时`));
      }, timeoutMs);
      this.pending.set(key, {
        grant,
        commandType,
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
  }

  take(correlationId?: number | bigint): PendingDebugRequest | undefined {
    if (correlationId == null) return undefined;
    const key = String(correlationId);
    const request = this.pending.get(key);
    this.pending.delete(key);
    if (request?.timer != null) window.clearTimeout(request.timer);
    return request;
  }

  nextVariableRefresh(): number {
    return ++this.variableRefreshId;
  }

  isCurrentVariableRefresh(refreshId: number): boolean {
    return refreshId === this.variableRefreshId;
  }

  reset(): void {
    this.pausePending = false;
    this.pauseWanted = false;
    this.surfacePauseActive = false;
    this.surfaceResumePending = false;
    this.grantRefreshNeeded = false;
    const cancellation = new Error("debug request was retired with its runtime timeline");
    for (const request of this.pending.values()) {
      if (request.timer != null) window.clearTimeout(request.timer);
      request.reject?.(cancellation);
    }
    this.pending.clear();
  }
}
