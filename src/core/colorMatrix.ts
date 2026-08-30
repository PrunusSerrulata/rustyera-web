import { RuntimeServiceError, serviceInteger } from "@/core/runtimeServiceProtocol";

/** Decode the core serde_json adjacent-tagged fixed matrix shape. */
export function decodeFixedColorMatrix(value: unknown): readonly (number | bigint)[] | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw invalidMatrix();
  const record = value as Record<string, unknown>;
  if (record.type !== "fixed") throw invalidMatrix();
  const candidate = record.value;
  if (!Array.isArray(candidate) || candidate.length !== 25) throw invalidMatrix();
  return matrixComponents(candidate, "HTML color matrix component");
}

/** Project snake's row-major 5x5, 1/256 fixed matrix into SVG's normalized 4x5 form. */
export function fixedColorMatrixFilter(value: unknown): string | undefined {
  const candidate = decodeFixedColorMatrix(value);
  if (!candidate) return undefined;
  return projectColorMatrix(candidate);
}

export function sceneColorMatrixFilter(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length !== 25) throw invalidMatrix();
  return projectColorMatrix(matrixComponents(value, "scene color matrix component"));
}

function matrixComponents(candidate: readonly unknown[], name: string): (number | bigint)[] {
  try {
    return candidate.map((item) => serviceInteger(item, name, true));
  } catch {
    throw invalidMatrix();
  }
}

function projectColorMatrix(candidate: readonly (number | bigint)[]): string {
  const matrix = [0, 1, 2, 3]
    .flatMap((row) => candidate.slice(row * 5, row * 5 + 5))
    .map((item) => Number(item) / 256);
  if (!matrix.every(Number.isFinite)) throw invalidMatrix();
  return matrix.join(" ");
}

function invalidMatrix(): RuntimeServiceError {
  return new RuntimeServiceError("invalid_request", "color matrix is not a fixed 5x5 matrix");
}
