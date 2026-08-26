import { markRaw, reactive, ref, toRaw, type Ref } from "vue";

import {
  applyDelta,
  applySnapshot,
  emptyPresentation,
  type PresentationState,
} from "@/core/presentation";

export class RuntimePresentationProjection {
  readonly presentation = reactive(emptyPresentation());
  readonly staged: Ref<boolean> = ref(false);

  private stagedPresentation?: PresentationState;
  private stagedReady = false;
  private stagedCanFlushWhenIdle = false;
  private stagedForInputTransition = false;

  current(): PresentationState {
    return this.stagedPresentation ?? this.presentation;
  }

  mutableInteractions(): PresentationState {
    return this.current();
  }

  openInputWait(inputWait: any): void {
    this.current().inputWait = inputWait;
    if (this.stagedPresentation) this.stagedReady = true;
    else this.stagedForInputTransition = false;
  }

  beginInputTransition(): void {
    if (this.current().inputWait == null) return;
    // Input submission replaces one stable interaction surface with another. Keep that change
    // atomic even when the runtime crosses an explicit REDRAW boundary while building the target.
    this.stage();
    this.stagedCanFlushWhenIdle = true;
    this.stagedForInputTransition = true;
  }

  closeInputWait(): void {
    this.beginInputTransition();
    this.current().inputWait = null;
  }

  publishForPresentNow(presentationRevision: unknown): boolean {
    const stagedRevision = String(this.current().revision);
    const expectedRevision = String(presentationRevision);
    if (stagedRevision !== expectedRevision) {
      throw new Error(`立即展示 revision 不匹配：期望 ${expectedRevision}，当前 ${stagedRevision}`);
    }
    if (!this.stagedPresentation) return false;
    const continueInputTransition = this.stagedForInputTransition;
    const published = this.publish();
    // Keep only the transition marker after the explicit display barrier. Creating an empty
    // staged clone here can strand it when present_now is the batch's final presentation event,
    // leaving the DOM on the just-published revision while later input waits advance off-screen.
    // If more output arrives, projectDelta will stage lazily from the published barrier frame.
    this.stagedForInputTransition = continueInputTransition && this.presentation.inputWait == null;
    return published;
  }

  shouldPublish(runtimeState: string): boolean {
    return (
      this.stagedReady ||
      (this.stagedCanFlushWhenIdle &&
        this.stagedPresentation != null &&
        !["more_work", "output_ready"].includes(runtimeState))
    );
  }

  publish(): boolean {
    const staged = this.stagedPresentation;
    if (!staged) return false;
    // Redraw-disabled map refreshes can delete and recreate their tail across separate deltas.
    // Compare the completed frame with the last published frame, not the staged intermediate
    // length, before deciding whether the viewport should follow new history to the bottom.
    if (staged.lines.length <= this.presentation.lines.length) {
      staged.historyRevision = this.presentation.historyRevision;
    }
    Object.assign(this.presentation, staged);
    this.discard();
    return true;
  }

  projectSnapshot(snapshot: any): boolean {
    markSnapshotPayloadsRaw(snapshot);
    const next = this.clone(this.current());
    applySnapshot(next, snapshot);
    if (next.redraw?.enabled === false && next.inputWait == null) {
      this.stagedPresentation = next;
      this.stagedReady = false;
      this.stagedCanFlushWhenIdle = false;
      this.stagedForInputTransition = false;
      this.staged.value = true;
      return false;
    }
    this.discard();
    Object.assign(this.presentation, next);
    return true;
  }

  projectDelta(delta: any): boolean {
    markDeltaPayloadsRaw(delta);
    const operations = delta.operations ?? [];
    const disablesRedraw = operations.some(
      (operation: any) => operation.type === "set_redraw" && operation.redraw?.enabled === false,
    );
    const enablesRedraw = operations.some(
      (operation: any) => operation.type === "set_redraw" && operation.redraw?.enabled !== false,
    );
    const opensInputWait = operations.some(
      (operation: any) => operation.type === "set_input_wait" && operation.input_wait != null,
    );
    const closesInputWait = operations.some(
      (operation: any) => operation.type === "set_input_wait" && operation.input_wait == null,
    );
    const completesFrame = enablesRedraw || opensInputWait;
    if (closesInputWait && this.current().inputWait != null) this.beginInputTransition();
    // CLEARLINE commonly lands in its own output batch between timed animation frames. Emuera
    // repaints the replacement immediately, but publishing that intermediate tail deletion lets
    // the browser paint an empty frame before the next zero-delay pump. Hold the previous frame
    // until replacement output, a wait/redraw boundary, or a genuinely idle runtime arrives.
    const startsTransientReplacement =
      this.presentation.inputWait == null &&
      !completesFrame &&
      operations.some((operation: any) =>
        ["clear", "delete_lines"].includes(String(operation.type)),
      );
    const shouldStage =
      this.stagedPresentation != null ||
      this.stagedForInputTransition ||
      (!completesFrame &&
        ((this.presentation.redraw?.enabled === false && this.presentation.inputWait == null) ||
          disablesRedraw ||
          startsTransientReplacement));
    const target = shouldStage ? this.stage() : this.presentation;
    if (target === this.stagedPresentation) this.prepareStagedLines(operations);
    applyDelta(target, delta);
    if (target !== this.stagedPresentation) return true;
    if (disablesRedraw || target.redraw?.enabled === false) this.stagedCanFlushWhenIdle = false;
    else if (startsTransientReplacement) this.stagedCanFlushWhenIdle = true;
    if (opensInputWait || (completesFrame && !this.stagedForInputTransition)) {
      this.stagedReady = true;
    }
    return false;
  }

  discard(): void {
    this.stagedPresentation = undefined;
    this.stagedReady = false;
    this.stagedCanFlushWhenIdle = false;
    this.stagedForInputTransition = false;
    this.staged.value = false;
  }

  reset(): void {
    this.discard();
    Object.assign(this.presentation, emptyPresentation());
  }

  private stage(): PresentationState {
    if (!this.stagedPresentation) {
      this.stagedPresentation = this.clone(this.presentation, false);
      this.stagedReady = false;
      this.stagedCanFlushWhenIdle = false;
      this.staged.value = true;
    }
    return this.stagedPresentation;
  }

  private prepareStagedLines(operations: any[]): void {
    const staged = this.stagedPresentation;
    if (!staged || staged.lines !== toRaw(this.presentation).lines) return;
    for (const operation of operations) {
      switch (operation.type) {
        case "clear":
          // CLEAR replaces the container before any later history operation, so it needs no copy.
          return;
        case "append_line":
        case "delete_lines":
        case "replace_line":
        case "trim_lines":
          staged.lines = [...staged.lines];
          return;
      }
    }
  }

  private clone(source: PresentationState, copyLines = true): PresentationState {
    const raw = toRaw(source);
    // Immutable line payloads stay shared. Staging may also share the container until the first
    // history mutation; snapshots request an immediate shallow container copy.
    return {
      ...raw,
      lines: copyLines ? [...raw.lines] : raw.lines,
      nextInteractionSequence: raw.nextInteractionSequence,
      retiredInteractionSequence: raw.retiredInteractionSequence,
    };
  }
}

function markSnapshotPayloadsRaw(snapshot: any): void {
  for (const line of snapshot.history?.logical_lines ?? []) markObjectRaw(line);
  for (const document of snapshot.html_island ?? []) markObjectRaw(document);
  markObjectRaw(snapshot.resources);
}

function markDeltaPayloadsRaw(delta: any): void {
  for (const operation of delta.operations ?? []) {
    if (["append_line", "replace_line"].includes(operation.type)) {
      markObjectRaw(operation.line);
    } else if (operation.type === "set_html_island") {
      for (const document of operation.html_island ?? []) markObjectRaw(document);
    } else if (operation.type === "set_resources") {
      markObjectRaw(operation.resources);
    }
  }
}

function markObjectRaw(value: unknown): void {
  if (value != null && typeof value === "object") markRaw(value);
}
