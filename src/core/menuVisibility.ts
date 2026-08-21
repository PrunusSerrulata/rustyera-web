export type MenuVisibilityMode = "SHOW" | "AUTO" | "HIDE";

export const menuVisibilityOptions: { value: MenuVisibilityMode; label: string }[] = [
  { value: "SHOW", label: "显示" },
  { value: "AUTO", label: "自动" },
  { value: "HIDE", label: "不显示" },
];

export function normalizeMenuVisibilityMode(value: unknown): MenuVisibilityMode | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toUpperCase()) {
    case "SHOW":
      return "SHOW";
    case "AUTO":
    case "YES":
    case "TRUE":
    case "1":
    case "前":
      return "AUTO";
    case "HIDE":
    case "NO":
    case "FALSE":
    case "0":
    case "後":
      return "HIDE";
    default:
      return undefined;
  }
}

export function menuVisibilityMode(value: unknown): MenuVisibilityMode {
  return normalizeMenuVisibilityMode(value) ?? "AUTO";
}

export function normalizeMenuSetting(
  settings: Record<string, string> | undefined,
): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(settings ?? {}).filter(
      ([code, setting]) => typeof code === "string" && typeof setting === "string",
    ),
  );
  if (!Object.hasOwn(normalized, "UseMenu")) return normalized;
  const mode = normalizeMenuVisibilityMode(normalized.UseMenu);
  if (mode == null) delete normalized.UseMenu;
  else normalized.UseMenu = mode;
  return normalized;
}

export function menuVisibleAtHeight(mode: MenuVisibilityMode, height: number): boolean {
  return mode === "SHOW" || (mode === "AUTO" && height >= 480);
}
