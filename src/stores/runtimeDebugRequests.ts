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
  private readonly submissions = new Map<object, (error: Error) => void>();
  private readonly earlyReplies = new Map<string, () => Promise<void>>();

  async submit<T>(
    send: () => Promise<number | bigint>,
    register: (messageId: number | bigint) => T | Promise<T>,
  ): Promise<T> {
    const submission = {};
    let retire!: (error: Error) => void;
    const retired = new Promise<never>((_resolve, reject) => {
      retire = reject;
    });
    this.submissions.set(submission, retire);
    try {
      const messageId = await Promise.race([send(), retired]);
      if (!this.submissions.has(submission))
        throw new Error("debug request was retired with its runtime timeline");
      const response = Promise.resolve(register(messageId));
      // An early error may reject the waiter while its normal handler is still completing.
      void response.catch(() => undefined);
      const key = String(messageId);
      const replay = this.earlyReplies.get(key);
      this.earlyReplies.delete(key);
      this.finishSubmission(submission);
      await replay?.();
      return response;
    } finally {
      this.finishSubmission(submission);
    }
  }

  deferReply(correlationId: number | bigint | undefined, handle: () => Promise<void>): boolean {
    if (correlationId == null || this.submissions.size === 0) return false;
    const key = String(correlationId);
    if (this.pending.has(key)) return false;
    if (this.earlyReplies.has(key)) throw new Error("duplicate early debug reply");
    if (this.earlyReplies.size >= 64) throw new Error("early debug reply limit exceeded");
    // Never block the pump on submitDebug: its native response can arrive first.
    this.earlyReplies.set(key, handle);
    return true;
  }

  private finishSubmission(submission: object): void {
    this.submissions.delete(submission);
    if (this.submissions.size === 0) this.earlyReplies.clear();
  }

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
    for (const retire of this.submissions.values()) retire(cancellation);
    this.submissions.clear();
    this.earlyReplies.clear();
    for (const request of this.pending.values()) {
      if (request.timer != null) window.clearTimeout(request.timer);
      request.reject?.(cancellation);
    }
    this.pending.clear();
  }
}
