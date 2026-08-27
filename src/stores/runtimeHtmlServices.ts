import { decodeHtmlServiceQuery, htmlAdvanceMillipixels } from "@/core/htmlServiceProtocol";
import {
  RuntimeServiceError,
  projectionMap,
  sameProjection,
  type ProjectionQueryContext,
} from "@/core/runtimeServiceProtocol";
import type {
  HtmlMeasurementBinding,
  HtmlMeasurementGuard,
  HtmlMeasurementProvider,
} from "@/platform/htmlMeasurement";
import type { RuntimeServiceLease } from "@/stores/runtimeServiceRequests";

export interface RuntimeHtmlServiceProvider {
  prepare(
    context: ProjectionQueryContext,
    lease: RuntimeServiceLease,
  ): Promise<{ binding: HtmlMeasurementBinding; guard: HtmlMeasurementGuard }>;
  measurement: Pick<HtmlMeasurementProvider, "measure" | "measureImageSlot" | "ensureFixedSlot">;
}

/** Providers return CSS metrics only. Core retains slicing, line policy and RESULTS writes. */
export async function resolveHtmlRuntimeService(
  payload: unknown,
  provider: RuntimeHtmlServiceProvider | undefined,
  lease: RuntimeServiceLease,
): Promise<Map<number, unknown>> {
  const query = decodeHtmlServiceQuery(payload);
  if (!provider)
    throw new RuntimeServiceError("unsupported", "HTML v2 measurement provider is not installed");
  const prepared = await provider.prepare(query.context, lease);
  lease.assertActive();
  prepared.guard.assertCurrent();
  if (!sameProjection(prepared.binding.context, query.context))
    throw new RuntimeServiceError(
      "stale_projection",
      "prepared HTML context differs from the request",
    );
  const results: Map<number, unknown>[] = [];
  for (const probe of query.probes) {
    lease.assertActive();
    prepared.guard.assertCurrent();
    let result: [number, unknown[]];
    switch (probe.mode) {
      case "text_part": {
        const measured = await provider.measurement.measure(
          { document: probe.document, mode: "text_part", cuts: probe.cuts, style: query.style },
          prepared.binding,
          prepared.guard,
        );
        lease.assertActive();
        prepared.guard.assertCurrent();
        requireContext(measured.context, query.context);
        if (!Array.isArray(measured.cuts) || measured.cuts.length !== probe.cuts.length)
          throw new RuntimeServiceError(
            "backend_failure",
            "HTML provider returned a wrong cut count",
          );
        const remaining = new Map(probe.cuts.map((cut) => [cut.id, cut]));
        const cuts = measured.cuts.map((cut) => {
          if (!Number.isSafeInteger(cut.id) || !remaining.delete(cut.id))
            throw new RuntimeServiceError(
              "backend_failure",
              "HTML provider returned a duplicate or unknown cut",
            );
          return new Map<number, unknown>([
            [0, cut.id],
            [1, htmlAdvanceMillipixels(cut.advancePx)],
          ]);
        });
        result = [0, [htmlAdvanceMillipixels(measured.advancePx), cuts]];
        break;
      }
      case "image_slot": {
        const measured = await provider.measurement.measureImageSlot(
          { document: probe.document, missingDocument: probe.missingDocument, style: query.style },
          prepared.binding,
          prepared.guard,
        );
        lease.assertActive();
        prepared.guard.assertCurrent();
        requireContext(measured.context, query.context);
        if (measured.type === "loaded") {
          for (const dimension of [measured.naturalWidth, measured.naturalHeight]) {
            if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 1_048_576)
              throw new RuntimeServiceError(
                "backend_failure",
                "HTML provider returned invalid sprite dimensions",
              );
          }
          result = [2, [measured.naturalWidth, measured.naturalHeight]];
        } else if (measured.type === "missing")
          result = [3, [htmlAdvanceMillipixels(measured.fallbackAdvancePx)]];
        else
          throw new RuntimeServiceError(
            "backend_failure",
            "HTML provider returned an invalid image state",
          );
        break;
      }
      case "fixed_slot": {
        const measured = await provider.measurement.ensureFixedSlot(
          { document: probe.document, style: query.style },
          prepared.binding,
          prepared.guard,
        );
        lease.assertActive();
        prepared.guard.assertCurrent();
        requireContext(measured.context, query.context);
        if (measured.type !== "ready")
          throw new RuntimeServiceError(
            "backend_failure",
            "HTML provider did not confirm slot readiness",
          );
        result = [4, []];
        break;
      }
    }
    results.push(
      new Map<number, unknown>([
        [0, probe.id],
        [1, result],
      ]),
    );
  }
  lease.assertActive();
  prepared.guard.assertCurrent();
  return new Map<number, unknown>([
    [0, projectionMap(query.context)],
    [1, results],
  ]);
}

function requireContext(actual: ProjectionQueryContext, expected: ProjectionQueryContext): void {
  if (!sameProjection(actual, expected))
    throw new RuntimeServiceError(
      "stale_projection",
      "HTML measurement returned an obsolete projection",
    );
}
