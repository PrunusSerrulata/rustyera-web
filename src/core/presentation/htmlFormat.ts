/** Pure presentation-to-legacy-HTML formatting helpers. */

export function projectedLength(length: any, lineHeight: number): string {
  const value = Number(length?.value ?? 0);
  if (length?.unit === "logical") return `${Math.trunc(value / 1000)}px`;
  if (length?.unit === "pixels") return `${Math.trunc(value)}px`;
  return String(Math.trunc((value * Number(lineHeight)) / 100_000));
}

export function rawLength(length: any): string {
  const value = Number(length?.value ?? 0);
  if (length?.unit === "logical") return `${Math.trunc(value / 1000)}px`;
  if (length?.unit === "pixels") return `${Math.trunc(value)}px`;
  return String(Math.trunc(value));
}

export function htmlColor(color: any): string {
  return `#${[color.red, color.green, color.blue]
    .map((component) =>
      Number(component ?? 0)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase(),
    )
    .join("")}`;
}

export function isDefaultForeground(color: any): boolean {
  return Number(color.red) === 192 && Number(color.green) === 192 && Number(color.blue) === 192;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll(">", "&gt;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
