import { reactive, ref, toRaw, type Ref } from "vue";

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

  current(): PresentationState {
    return this.stagedPresentation ?? this.presentation;
  }

  markStagedReady(): void {
    if (this.stagedPresentation) this.stagedReady = true;
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
    const next = this.clone(this.current());
    applySnapshot(next, snapshot);
    if (next.redraw?.enabled === false && next.inputWait == null) {
      this.stagedPresentation = next;
      this.stagedReady = false;
      this.stagedCanFlushWhenIdle = false;
      this.staged.value = true;
      return false;
    }
    this.discard();
    Object.assign(this.presentation, next);
    return true;
  }

  projectDelta(delta: any): boolean {
    const operations = delta.operations ?? [];
    const disablesRedraw = operations.some(
      (operation: any) => operation.type === "set_redraw" && operation.redraw?.enabled === false,
    );
    const completesFrame = operations.some(
      (operation: any) =>
        (operation.type === "set_redraw" && operation.redraw?.enabled !== false) ||
        (operation.type === "set_input_wait" && operation.input_wait != null),
    );
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
      (this.presentation.redraw?.enabled === false && this.presentation.inputWait == null) ||
      disablesRedraw ||
      startsTransientReplacement;
    const target = shouldStage ? this.stage() : this.presentation;
    applyDelta(target, delta);
    if (target !== this.stagedPresentation) return true;
    if (disablesRedraw || target.redraw?.enabled === false) this.stagedCanFlushWhenIdle = false;
    else if (startsTransientReplacement) this.stagedCanFlushWhenIdle = true;
    if (completesFrame) this.stagedReady = true;
    return false;
  }

  discard(): void {
    this.stagedPresentation = undefined;
    this.stagedReady = false;
    this.stagedCanFlushWhenIdle = false;
    this.staged.value = false;
  }

  reset(): void {
    this.discard();
    Object.assign(this.presentation, emptyPresentation());
  }

  private stage(): PresentationState {
    if (!this.stagedPresentation) {
      this.stagedPresentation = this.clone(this.presentation);
      this.stagedReady = false;
      this.stagedCanFlushWhenIdle = false;
      this.staged.value = true;
    }
    return this.stagedPresentation;
  }

  private clone(source: PresentationState): PresentationState {
    return structuredClone(toRaw(source));
  }
}
