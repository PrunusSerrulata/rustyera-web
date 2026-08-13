import { decodeImageMetadata } from "@/core/imageMetadata";
import { plainLine, printedHtmlLine, type PresentationState } from "@/core/presentation";
import { at, mapOf } from "@/core/runtimeSupport";
import { decodeServicePayload, encodeServicePayload } from "@/core/serviceCodec";
import type { FrontendBridge, RuntimeMessage } from "@/core/types";

interface RuntimeServiceContext {
  bridge: Pick<FrontendBridge, "readImageMetadata" | "readResource">;
  currentPresentation(): PresentationState;
  heldKeys: ReadonlySet<number>;
  clock(): Date | undefined;
  nextEntropy(): bigint | undefined;
  send(message: RuntimeMessage, correlationId?: number): Promise<unknown>;
}

export async function handleRuntimeService(
  request: any,
  correlationId: number | undefined,
  context: RuntimeServiceContext,
): Promise<void> {
  try {
    const query = decodeServicePayload(request.payload);
    const presentation = context.currentPresentation();
    const response = await resolveRuntimeService(request, query, presentation, context);
    await context.send(
      {
        type: "service_response",
        value: {
          request_id: request.request_id,
          result: { type: "ready", payload: [...encodeServicePayload(response)] },
        },
      },
      correlationId,
    );
  } catch (error) {
    await context.send(
      {
        type: "service_response",
        value: {
          request_id: request.request_id,
          result: {
            type: "error",
            error: {
              code: "frontend.unsupported_service",
              message: `${request.kind}/${request.operation}: ${String(error)}`,
            },
          },
        },
      },
      correlationId,
    );
  }
}

async function resolveRuntimeService(
  request: any,
  query: any,
  presentation: PresentationState,
  context: RuntimeServiceContext,
): Promise<Map<number, unknown>> {
  switch (`${request.kind}/${request.operation}`) {
    case "entropy/random_seed": {
      const entropy = context.nextEntropy();
      if (entropy != null) return mapOf([0, entropy]);
      const bytes = crypto.getRandomValues(new Uint32Array(2));
      return mapOf([0, (BigInt(bytes[0]) << 32n) | BigInt(bytes[1])]);
    }
    case "clock/local_date_time": {
      const now = context.clock() ?? new Date();
      return mapOf(
        [0, now.getFullYear()],
        [1, now.getMonth() + 1],
        [2, now.getDate()],
        [3, now.getHours()],
        [4, now.getMinutes()],
        [5, now.getSeconds()],
        [6, now.getMilliseconds()],
        [7, -now.getTimezoneOffset()],
      );
    }
    case "input_state/get_key_state": {
      const code = Number(at(query, 0));
      return mapOf([0, document.hasFocus()], [1, context.heldKeys.has(code)], [2, false]);
    }
    case "image/image_metadata": {
      const metadata = await context.bridge.readImageMetadata(String(at(query, 0)));
      return mapOf(
        [0, metadata.width],
        [1, metadata.height],
        [2, metadata.format],
        [3, metadata.animated],
      );
    }
    case "image/image_pixel": {
      const resource = String(at(query, 0));
      const bitmap = await createImageBitmap(
        new Blob([(await context.bridge.readResource(resource)) as BlobPart]),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const canvasContext = canvas.getContext("2d", { willReadFrequently: true })!;
      canvasContext.drawImage(bitmap, 0, 0);
      const pixel = canvasContext.getImageData(
        Number(at(query, 2)),
        Number(at(query, 3)),
        1,
        1,
      ).data;
      bitmap.close();
      return mapOf([0, ((pixel[3] << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]) >>> 0]);
    }
    case "canvas/decode_canvas_image": {
      const metadata = decodeImageMetadata(at(query, 0) as Uint8Array);
      return mapOf([0, metadata.width], [1, metadata.height]);
    }
    case "presentation_query/get_display_line": {
      const index = Number(at(query, 1));
      return mapOf(
        [0, at(query, 0)],
        [1, presentation.lines[index] ? plainLine(presentation.lines[index]) : ""],
      );
    }
    case "presentation_query/html_get_printed_str": {
      const index = Number(at(query, 1));
      const text = presentation.lines.at(-(index + 1));
      return mapOf(
        [0, at(query, 0)],
        [1, text ? printedHtmlLine(text, Number(presentation.settings.line_height ?? 0)) : ""],
      );
    }
    case "presentation_query/serialize_physical_history": {
      const body = presentation.lines.map(plainLine).join("\n");
      return mapOf([0, at(query, 0)], [1, at(query, 2) ? body : `${at(query, 1)}\n\n${body}`]);
    }
    case "font_metrics/gget_text_size": {
      const text = String(at(query, 1));
      const canvas = document.createElement("canvas");
      const canvasContext = canvas.getContext("2d")!;
      canvasContext.font = `${Number(at(query, 3)) / 1000}pt ${String(at(query, 2))}`;
      const metrics = canvasContext.measureText(text);
      return mapOf(
        [0, at(query, 0)],
        [1, Math.ceil(metrics.width)],
        [2, Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)],
      );
    }
    default:
      throw new Error(`不支持的前端服务：${request.kind}/${request.operation}`);
  }
}
