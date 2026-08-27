export type RuntimeServiceFailure =
  "unsupported" | "invalid_request" | "stale_projection" | "resource_limit" | "backend_failure";

export class RuntimeServiceError extends Error {
  constructor(
    readonly category: RuntimeServiceFailure,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeServiceError";
  }
}
