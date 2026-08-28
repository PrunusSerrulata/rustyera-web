import { nextTick, ref } from "vue";

import type { RuntimeMessage } from "@/core/types";
import {
  sameServiceInteger,
  type ProjectionQueryContext,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { GameViewportMeasurement } from "@/platform/viewportMeasurement";

interface ViewportObservation {
  environmentRevision: number;
  projectionSpaceRevision: number;
  width: number;
  height: number;
  lineColumns: number;
  textBox: string;
  styleIdentity: string;
  messageId: string;
}

export class RuntimeViewportState {
  readonly measurement = ref<GameViewportMeasurement>();
  readonly pendingMessages = new Set<string>();
  private environmentRevision = 1;
  private invalidatedThroughRevision = 0;
  private generation = 0;
  private readonly rejectedMessages = new Set<string>();
  private readonly submittedObservations = new Map<number, ViewportObservation>();
  private readonly pendingRevisions = new Set<number>();
  private observation?: ViewportObservation;

  constructor(private readonly send: (message: RuntimeMessage) => Promise<number | bigint>) {}

  async observe(
    measurement: GameViewportMeasurement | undefined,
    runtimeReady: boolean,
    presentationRevision: ServiceInteger,
    textBox: string,
    styleIdentity = "",
  ): Promise<void> {
    if (!measurement) return;
    this.measurement.value = measurement;
    if (!runtimeReady) return;
    const observed = this.observation;
    // Publishing output alone does not change the measured environment. Reusing
    // its identity keeps the observation barrier from invalidating its own query.
    if (
      observed &&
      observed.width === measurement.width &&
      observed.height === measurement.height &&
      observed.lineColumns === measurement.lineColumns &&
      observed.textBox === textBox &&
      observed.styleIdentity === styleIdentity
    )
      return;
    const generation = this.generation;
    const revision = this.environmentRevision++;
    this.pendingRevisions.add(revision);
    this.observation = undefined;
    const messageId = await this.send({
      type: "projection_observation",
      value: {
        environment_revision: revision,
        presentation_revision: presentationRevision,
        client_size: { width: measurement.width, height: measurement.height },
        projection_space_revision: revision,
        line_columns: measurement.lineColumns,
        text_box: textBox,
        transform: {
          x_numerator: 1,
          x_denominator: 1000,
          y_numerator: 1,
          y_denominator: 1000,
          origin_x: 0,
          origin_y: 0,
        },
      },
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.pendingRevisions.delete(revision);
        // A transport failure does not prove that core rejected the observation.
        this.invalidatedThroughRevision = this.environmentRevision - 1;
        this.submittedObservations.clear();
        this.observation = undefined;
      }
      throw error;
    });
    if (generation !== this.generation) return;
    this.pendingRevisions.delete(revision);
    if (revision <= this.invalidatedThroughRevision) return;
    const rejected = this.rejectedMessages.delete(String(messageId));
    if (!rejected) {
      this.submittedObservations.set(revision, {
        environmentRevision: revision,
        projectionSpaceRevision: revision,
        width: measurement.width,
        height: measurement.height,
        lineColumns: measurement.lineColumns,
        textBox,
        styleIdentity,
        messageId: String(messageId),
      });
      if (this.submittedObservations.size > 256)
        this.submittedObservations.delete(Math.min(...this.submittedObservations.keys()));
    }
    this.selectObservation();
    if (rejected) return;
    if (this.pendingMessages.size >= 256) this.pendingMessages.clear();
    this.pendingMessages.add(String(messageId));
  }

  private selectObservation(): void {
    let latest: ViewportObservation | undefined;
    for (const candidate of this.submittedObservations.values())
      if (!latest || candidate.environmentRevision > latest.environmentRevision) latest = candidate;
    // A rejected candidate never became core's environment. Keep its predecessor,
    // but do not expose it while any newer submission is still unresolved.
    this.observation = latest;
    if (latest)
      for (const revision of this.pendingRevisions)
        if (revision > latest.environmentRevision) {
          this.observation = undefined;
          break;
        }
  }

  matches(
    context: ProjectionQueryContext,
    publishedRevision: ServiceInteger,
    measurement: Pick<GameViewportMeasurement, "width" | "height"> | undefined,
    styleIdentity = "",
  ): boolean {
    const observed = this.observation;
    return (
      observed != null &&
      measurement != null &&
      sameServiceInteger(context.presentationRevision, publishedRevision) &&
      sameServiceInteger(context.environmentRevision, observed.environmentRevision) &&
      sameServiceInteger(context.projectionSpaceRevision, observed.projectionSpaceRevision) &&
      observed.width === measurement.width &&
      observed.height === measurement.height &&
      observed.styleIdentity === styleIdentity
    );
  }

  reject(messageId: string): void {
    if (this.rejectedMessages.size >= 256)
      this.rejectedMessages.delete(this.rejectedMessages.values().next().value!);
    this.rejectedMessages.add(messageId);
    for (const [revision, candidate] of this.submittedObservations)
      if (candidate.messageId === messageId) this.submittedObservations.delete(revision);
    this.selectObservation();
  }

  chrome(measurement = this.measurement.value): { width: number; height: number } {
    return measurement
      ? { width: measurement.chromeWidth, height: measurement.chromeHeight }
      : { width: 0, height: 0 };
  }

  async settle(observe: () => Promise<void>): Promise<void> {
    await nextTick();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(finish, 100);
      requestAnimationFrame(finish);
    });
    await observe();
  }

  reset(): void {
    this.generation += 1;
    this.observation = undefined;
    this.pendingMessages.clear();
    this.rejectedMessages.clear();
    this.submittedObservations.clear();
    this.pendingRevisions.clear();
    this.environmentRevision = 1;
    this.invalidatedThroughRevision = 0;
  }
}
