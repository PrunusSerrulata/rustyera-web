import { nextTick, ref } from "vue";

import type { RuntimeMessage } from "@/core/types";
import {
  sameServiceInteger,
  type ProjectionQueryContext,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import type { GameViewportMeasurement } from "@/platform/viewportMeasurement";

export class RuntimeViewportState {
  readonly measurement = ref<GameViewportMeasurement>();
  readonly pendingMessages = new Set<string>();
  private environmentRevision = 1;
  private generation = 0;
  private latestSubmittedRevision = 0;
  private readonly rejectedMessages = new Set<string>();
  private observation?: {
    environmentRevision: number;
    projectionSpaceRevision: number;
    width: number;
    height: number;
    styleIdentity: string;
    messageId: string;
  };

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
    const generation = this.generation;
    const revision = this.environmentRevision++;
    this.latestSubmittedRevision = revision;
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
    });
    if (generation !== this.generation || this.rejectedMessages.delete(String(messageId))) return;
    if (revision === this.latestSubmittedRevision) {
      this.observation = {
        environmentRevision: revision,
        projectionSpaceRevision: revision,
        width: measurement.width,
        height: measurement.height,
        styleIdentity,
        messageId: String(messageId),
      };
    }
    if (this.pendingMessages.size >= 256) this.pendingMessages.clear();
    this.pendingMessages.add(String(messageId));
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
    if (this.observation?.messageId === messageId) this.observation = undefined;
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
    this.environmentRevision = 1;
    this.latestSubmittedRevision = 0;
  }
}
