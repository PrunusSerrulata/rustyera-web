import { nextTick, ref } from "vue";

import type { RuntimeMessage } from "@/core/types";
import type { GameViewportMeasurement } from "@/platform/viewportMeasurement";

export class RuntimeViewportState {
  readonly measurement = ref<GameViewportMeasurement>();
  readonly pendingMessages = new Set<string>();
  private environmentRevision = 1;

  constructor(private readonly send: (message: RuntimeMessage) => Promise<number | bigint>) {}

  async observe(
    measurement: GameViewportMeasurement | undefined,
    runtimeReady: boolean,
    presentationRevision: number,
    textBox: string,
  ): Promise<void> {
    if (!measurement) return;
    this.measurement.value = measurement;
    if (!runtimeReady) return;
    const messageId = await this.send({
      type: "projection_observation",
      value: {
        environment_revision: this.environmentRevision,
        presentation_revision: presentationRevision,
        client_size: { width: measurement.width, height: measurement.height },
        projection_space_revision: this.environmentRevision++,
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
    if (this.pendingMessages.size >= 256) this.pendingMessages.clear();
    this.pendingMessages.add(String(messageId));
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
    this.pendingMessages.clear();
    this.environmentRevision = 1;
  }
}
