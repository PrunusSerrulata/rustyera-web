import type { SettingsField } from "@/core/settings";

export const yesNo = (code: string, label: string, description: string): SettingsField => ({
  code,
  label,
  description,
  control: "boolean",
});

export const integer = (
  code: string,
  label: string,
  description: string,
  min?: number,
  max?: number,
): SettingsField => ({
  code,
  label,
  description,
  control: "number",
  min,
  max,
});

export const range = (
  code: string,
  label: string,
  description: string,
  min: number,
  max: number,
): SettingsField => ({
  code,
  label,
  description,
  control: "range",
  min,
  max,
});

export function warningField(code: string, label: string, description: string): SettingsField {
  return {
    code,
    label,
    description,
    control: "enum",
    options: [
      { value: "IGNORE", label: "忽略" },
      { value: "LATER", label: "延后显示" },
      { value: "ONCE", label: "每文件一次" },
      { value: "DISPLAY", label: "立即显示" },
    ],
  };
}
