interface SkippableWait {
  wait_id: unknown;
  kind: string;
  stop_message_skip?: boolean;
}

export class MessageSkipController {
  private active = false;
  private submittedWaitId: unknown;

  start(wait: SkippableWait | null | undefined): boolean {
    if (!this.isSkippable(wait)) {
      this.cancel();
      return false;
    }
    this.active = true;
    return this.take(wait);
  }

  continue(wait: SkippableWait | null | undefined): boolean {
    if (!this.active || !wait) return false;
    if (!this.isSkippable(wait)) {
      this.cancel();
      return false;
    }
    return this.take(wait);
  }

  cancel(): void {
    this.active = false;
    this.submittedWaitId = undefined;
  }

  private take(wait: SkippableWait): boolean {
    if (wait.wait_id === this.submittedWaitId) return false;
    this.submittedWaitId = wait.wait_id;
    return true;
  }

  private isSkippable(wait: SkippableWait | null | undefined): wait is SkippableWait {
    return wait?.kind === "enter_key" && !wait.stop_message_skip;
  }
}
