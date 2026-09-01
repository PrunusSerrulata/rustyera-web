import { ref } from "vue";

import {
  isMessageContinuationWait,
  isMessageSkipWait,
  messageWaitIntent,
} from "@/core/messageSkip";
import {
  restoreButtonBoundary,
  restoreSubmittedButtonBoundary,
  retirePresentedButtons,
  type PresentationState,
} from "@/core/presentation";
import type { InteractionToken, RuntimeMessage } from "@/core/types";
import type { PendingGameInput, PendingInputUndo, RuntimeInputIntent } from "@/stores/runtimeState";
import { inputMayHaveBeenAccepted } from "@/stores/runtimePump";

interface RuntimeInputContext {
  presentation(): PresentationState;
  mutableInteractions(): PresentationState;
  send(message: RuntimeMessage): Promise<number | bigint>;
  sampleMonotonic(): number;
  phase(): string;
  logWarning(message: string): void;
  signalMessageSkip(): Promise<void>;
}

export class RuntimeInputState {
  readonly pending = ref<PendingGameInput>();
  readonly pendingUndo = ref<PendingInputUndo>();
  private messageSkipRequested = false;

  constructor(private readonly context: RuntimeInputContext) {}

  async submit(intent: RuntimeInputIntent, messageSkip: boolean): Promise<boolean> {
    if (this.pending.value || this.pendingUndo.value) return false;
    const wait = this.context.presentation().inputWait;
    if (!wait) return false;
    const waitIdentity = inputWaitIdentity(wait);
    const previousRetiredInteractionSequence = retirePresentedButtons(
      this.context.mutableInteractions(),
    );
    this.pending.value = {
      waitIdentity,
      waitId: String(wait.wait_id),
      waitKind: String(wait.kind),
      intent,
      messageSkip,
      staleRetries: 0,
      previousRetiredInteractionSequence,
    };
    try {
      const messageId = await this.sendInput(wait, intent, messageSkip);
      if (this.pending.value?.waitIdentity === waitIdentity)
        this.pending.value.messageId = String(messageId);
    } catch (error) {
      if (this.pending.value?.waitIdentity === waitIdentity) {
        if (!inputMayHaveBeenAccepted(error))
          restoreButtonBoundary(
            this.context.mutableInteractions(),
            previousRetiredInteractionSequence,
          );
        this.pending.value = undefined;
      }
      throw error;
    }
    return true;
  }

  async requestMessageSkip(): Promise<void> {
    if (this.pending.value || this.pendingUndo.value) return;
    const wait = this.context.presentation().inputWait;
    if (isMessageContinuationWait(wait)) {
      // Snake Emuera consumes the current FORCEWAIT on a secondary click, then
      // lets that barrier stop automatic skipping at the next input boundary.
      // Preserve the compatibility mouse edge for non-physical secondary
      // actions before submitting the current continuation explicitly.
      if (wait.stop_message_skip) await this.context.signalMessageSkip();
      await this.submit(messageWaitIntent(wait), true);
      return;
    }
    this.messageSkipRequested = true;
    // Reference Emuera raises MesSkip on mouse-down. The store either reuses the
    // real secondary-button event or emits a balanced touch-accessibility pair.
    await this.context.signalMessageSkip();
    await this.settleMessageSkipRequest();
  }

  async settle(): Promise<void> {
    const pending = this.pending.value;
    if (!pending) {
      await this.settleMessageSkipRequest();
      return;
    }
    if (!pending.retryPending) {
      if (!pending.waitClosed) return;
      if (!pending.messageSkip) {
        const wait = this.context.presentation().inputWait;
        if (!wait || inputWaitIdentity(wait) === pending.waitIdentity) return;
        restoreSubmittedButtonBoundary(
          this.context.mutableInteractions(),
          pending.previousRetiredInteractionSequence,
        );
        this.pending.value = undefined;
        return;
      }
    }
    const wait = this.context.presentation().inputWait;
    if (!wait) {
      if (this.context.phase() === "running") return;
      this.pending.value = undefined;
      if (pending.retryError) this.context.logWarning(pending.retryError);
      return;
    }
    const waitIdentity = inputWaitIdentity(wait);
    if (waitIdentity === pending.waitIdentity) return;
    if (pending.messageSkip && !isMessageSkipWait(wait)) {
      this.pending.value = undefined;
      return;
    }
    if (String(wait.kind) !== pending.waitKind) {
      this.pending.value = undefined;
      this.context.logWarning(pending.retryError ?? "Runtime 拒绝了输入");
      return;
    }
    pending.waitIdentity = waitIdentity;
    pending.waitId = String(wait.wait_id);
    pending.waitClosed = false;
    pending.retryPending = false;
    pending.retryError = undefined;
    pending.staleRetries += 1;
    try {
      const messageId = await this.sendInput(wait, pending.intent, pending.messageSkip);
      if (this.pending.value === pending) pending.messageId = String(messageId);
    } catch (error) {
      if (this.pending.value === pending) this.pending.value = undefined;
      throw error;
    }
  }

  updateWait(wait: any): void {
    if (this.pending.value && this.pending.value.waitIdentity !== inputWaitIdentity(wait))
      this.pending.value.waitClosed = true;
  }

  closeWait(): void {
    if (this.pending.value) this.pending.value.waitClosed = true;
  }

  rejectInput(rejected: PendingGameInput | undefined, willRetry: boolean): void {
    if (!rejected || willRetry) return;
    restoreButtonBoundary(
      this.context.mutableInteractions(),
      rejected.previousRetiredInteractionSequence,
    );
    if (this.pending.value === rejected) this.pending.value = undefined;
  }

  applyUndo(value: any): void {
    const nextIdentity = value?.token ? interactionTokenIdentity(value.token) : undefined;
    if (this.pendingUndo.value?.tokenIdentity !== nextIdentity) this.pendingUndo.value = undefined;
  }

  async undo(token: InteractionToken): Promise<void> {
    const tokenIdentity = interactionTokenIdentity(token);
    this.pendingUndo.value = { tokenIdentity };
    try {
      const messageId = await this.context.send({ type: "input_undo_request", value: { token } });
      if (this.pendingUndo.value?.tokenIdentity === tokenIdentity)
        this.pendingUndo.value.messageId = String(messageId);
    } catch (error) {
      if (this.pendingUndo.value?.tokenIdentity === tokenIdentity)
        this.pendingUndo.value = undefined;
      throw error;
    }
  }

  rejectUndo(correlation: string): void {
    if (this.pendingUndo.value?.messageId === correlation) this.pendingUndo.value = undefined;
  }

  reset(): void {
    this.pending.value = undefined;
    this.pendingUndo.value = undefined;
    this.messageSkipRequested = false;
  }

  private async settleMessageSkipRequest(): Promise<void> {
    if (!this.messageSkipRequested || this.pending.value || this.pendingUndo.value) return;
    const wait = this.context.presentation().inputWait;
    if (!wait) return;
    if (!isMessageSkipWait(wait)) {
      this.messageSkipRequested = false;
      return;
    }
    const submitted = await this.submit(messageWaitIntent(wait), true);
    if (submitted) this.messageSkipRequested = false;
  }

  private sendInput(wait: any, intent: RuntimeInputIntent, messageSkip: boolean) {
    return this.context.send({
      type: "input",
      value: {
        wait_id: wait.wait_id,
        token: wait.submission_token,
        monotonic_time_ns: this.context.sampleMonotonic(),
        intent,
        message_skip: messageSkip,
      },
    });
  }
}

export function inputWaitIdentity(wait: any): string {
  return `${String(wait.wait_id)}:${String(wait.submission_token?.epoch)}:${String(wait.submission_token?.id)}`;
}

function interactionTokenIdentity(token: any): string {
  return `${String(token?.epoch)}:${String(token?.id)}`;
}
