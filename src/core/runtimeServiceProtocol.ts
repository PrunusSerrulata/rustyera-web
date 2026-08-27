import { decodeServicePayload } from "@/core/serviceCodec";

export type ServiceInteger = number | bigint;
export { RuntimeServiceError, type RuntimeServiceFailure } from "@/core/runtimeServiceError";
import { RuntimeServiceError } from "@/core/runtimeServiceError";
import { validateProjectionCbor } from "@/core/serviceCborValidation";

export const HTML_QUERY_OPERATIONS = new Set([
  "html_string_len",
  "html_substring",
  "html_string_lines",
]);
export function isHtmlQueryService(
  request: Pick<RuntimeServiceRequest, "kind" | "operation">,
): boolean {
  return request.kind === "presentation_query" && HTML_QUERY_OPERATIONS.has(request.operation);
}
export function isStrictProjectionService(
  request: Pick<RuntimeServiceRequest, "kind" | "operation">,
): boolean {
  return (
    isHtmlQueryService(request) ||
    (request.kind === "input_state" && request.operation === "pointer_state") ||
    (request.kind === "canvas" && request.operation === "sample_canvas_pixel")
  );
}

export interface ProjectionQueryContext {
  presentationRevision: ServiceInteger;
  environmentRevision: ServiceInteger;
  projectionSpaceRevision: ServiceInteger;
}

export interface CanvasPixelQuery {
  context: ProjectionQueryContext;
  canvasId: ServiceInteger;
  canvasRevision: ServiceInteger;
  x: number;
  y: number;
}

export interface RuntimeServiceRequest {
  request_id: ServiceInteger;
  kind: string;
  operation: string;
  operation_version: { major: number; minor: number };
  payload: Uint8Array | number[];
}

export function serviceInteger(value: unknown, name: string, signed = false): ServiceInteger {
  if (
    (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) ||
    BigInt(value as ServiceInteger) < (signed ? -(1n << 63n) : 0n) ||
    BigInt(value as ServiceInteger) > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
  )
    throw new RuntimeServiceError(
      "invalid_request",
      `${name} is not a ${signed ? "signed" : "unsigned"} 64-bit integer`,
    );
  return value as ServiceInteger;
}

export function sameServiceInteger(left: unknown, right: unknown): boolean {
  const valid = (value: unknown): value is ServiceInteger =>
    typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
  return valid(left) && valid(right) && BigInt(left) === BigInt(right);
}

export function sameProjection(
  left: ProjectionQueryContext,
  right: ProjectionQueryContext,
): boolean {
  return (
    sameServiceInteger(left.presentationRevision, right.presentationRevision) &&
    sameServiceInteger(left.environmentRevision, right.environmentRevision) &&
    sameServiceInteger(left.projectionSpaceRevision, right.projectionSpaceRevision)
  );
}

export function projectionMap(context: ProjectionQueryContext): Map<number, unknown> {
  return new Map([
    [0, context.presentationRevision],
    [1, context.environmentRevision],
    [2, context.projectionSpaceRevision],
  ]);
}

export function serviceMap(
  value: unknown,
  keys: readonly number[],
  name: string,
): Map<number, unknown> {
  if (!(value instanceof Map) || value.size !== keys.length || keys.some((key) => !value.has(key)))
    throw new RuntimeServiceError("invalid_request", `${name} has an invalid CBOR map shape`);
  return value;
}

export function projectionQuery(value: unknown): ProjectionQueryContext {
  const fields = serviceMap(value, [0, 1, 2], "projection context");
  return {
    presentationRevision: serviceInteger(fields.get(0), "presentation revision"),
    environmentRevision: serviceInteger(fields.get(1), "environment revision"),
    projectionSpaceRevision: serviceInteger(fields.get(2), "projection space revision"),
  };
}

export function canvasPixelQuery(value: unknown): CanvasPixelQuery {
  const fields = serviceMap(value, [0, 1, 2, 3], "canvas pixel request");
  const point = serviceMap(fields.get(3), [0, 1], "canvas point");
  const coordinate = (value: unknown): number => {
    const integer = serviceInteger(value, "canvas coordinate", true);
    if (integer < -2147483648 || integer > 2147483647)
      throw new RuntimeServiceError("invalid_request", "canvas coordinate exceeds i32");
    return Number(integer);
  };
  return {
    context: projectionQuery(fields.get(0)),
    canvasId: serviceInteger(fields.get(1), "canvas identity", true),
    canvasRevision: serviceInteger(fields.get(2), "canvas revision"),
    x: coordinate(point.get(0)),
    y: coordinate(point.get(1)),
  };
}

export function validateServiceRequest(request: RuntimeServiceRequest): unknown {
  serviceInteger(request.request_id, "service request ID");
  if (typeof request.kind !== "string" || typeof request.operation !== "string")
    throw new RuntimeServiceError("invalid_request", "service identity is invalid");
  const version = request.operation_version;
  if (
    !version ||
    !Number.isInteger(version.major) ||
    !Number.isInteger(version.minor) ||
    version.major < 0 ||
    version.major > 65535 ||
    version.minor < 0 ||
    version.minor > 65535
  )
    throw new RuntimeServiceError("invalid_request", "service operation version is invalid");
  const major = isHtmlQueryService(request) ? 2 : 1;
  if (version.major !== major || version.minor !== 0)
    throw new RuntimeServiceError(
      "unsupported",
      `service operation version ${version.major}.${version.minor} is not implemented`,
    );
  // Buffer and cross-realm Uint8Array values still carry the same byte contract.
  const byteView =
    ArrayBuffer.isView(request.payload) &&
    Object.prototype.toString.call(request.payload) === "[object Uint8Array]" &&
    request.payload.byteLength === request.payload.length;
  if (!byteView && !Array.isArray(request.payload))
    throw new RuntimeServiceError("invalid_request", "service payload is not bytes");
  if (request.payload.length > (isHtmlQueryService(request) ? 2 : 16) * 1024 * 1024)
    throw new RuntimeServiceError("resource_limit", "service payload exceeds the frontend budget");
  if (
    request.payload.some(
      (byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255,
    )
  )
    throw new RuntimeServiceError("invalid_request", "service payload contains a non-byte value");
  try {
    if (isStrictProjectionService(request))
      validateProjectionCbor(
        request.payload instanceof Uint8Array ? request.payload : Uint8Array.from(request.payload),
      );
    return decodeServicePayload(request.payload);
  } catch (error) {
    if (error instanceof RuntimeServiceError) throw error;
    throw new RuntimeServiceError("invalid_request", `invalid service CBOR: ${String(error)}`);
  }
}
