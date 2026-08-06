import { nextTick, reactive } from "vue";
import { describe, expect, it, vi } from "vitest";

import { useSettingsDraft } from "@/components/useSettingsDraft";
import type { SettingsField } from "@/core/settings";
import { defaultPreferences, type ProjectConfigurationEntry } from "@/core/types";

describe("settings draft domain", () => {
  it("collects changes across tabs, locates validation errors, and rolls preview back", async () => {
    const state = reactive({
      open: false,
      readOnly: false,
      preferences: defaultPreferences(),
      entries: [
        entry("UseMouse", "YES", "boolean"),
        entry("FontSize", "18", "integer"),
        entry("LineHeight", "19", "integer"),
      ] as ProjectConfigurationEntry[],
    });
    const preview = vi.fn();
    const draft = useSettingsDraft({
      open: () => state.open,
      preferences: () => state.preferences,
      configurationEntries: () => state.entries,
      configurationReadOnly: () => state.readOnly,
      preview,
    });
    state.open = true;
    await nextTick();
    draft.configurationDraft.UseMouse = "NO";
    draft.configurationDraft.FontSize = "20";

    expect(draft.changes()).toEqual([
      { code: "UseMouse", value: "NO" },
      { code: "FontSize", value: "20" },
    ]);
    expect(draft.validateAll()).toBe(false);
    expect(draft.activeTab.value).toBe("display");
    expect(draft.fieldErrors.LineHeight).toContain("不能小于字号");

    draft.draft.imageScale = 2;
    draft.cancelDraft();
    expect(draft.draft.imageScale).toBe(1);
    expect(draft.configurationDraft.UseMouse).toBe("YES");
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("preserves dependent drafts while projecting forced disabled values", async () => {
    const state = reactive({
      open: false,
      entries: [
        entry("SystemSaveInBinary", "NO", "boolean"),
        entry("ZipSaveData", "YES", "boolean"),
        entry("AllowFunctionOverloading", "NO", "boolean"),
        entry("WarnFunctionOverloading", "NO", "boolean"),
      ] as ProjectConfigurationEntry[],
    });
    const draft = useSettingsDraft({
      open: () => state.open,
      preferences: defaultPreferences,
      configurationEntries: () => state.entries,
      configurationReadOnly: () => false,
      preview: vi.fn(),
    });
    state.open = true;
    await nextTick();
    const zip: SettingsField = { code: "ZipSaveData", label: "压缩", control: "boolean" };
    const warning: SettingsField = {
      code: "WarnFunctionOverloading",
      label: "警告",
      control: "boolean",
    };

    expect(draft.fieldDisabled(zip, false)).toBe(true);
    expect(draft.configurationDraft.ZipSaveData).toBe("YES");
    expect(draft.checked(warning)).toBe(true);
    expect(draft.configurationDraft.WarnFunctionOverloading).toBe("NO");

    draft.configurationDraft.SystemSaveInBinary = "YES";
    draft.configurationDraft.AllowFunctionOverloading = "YES";
    expect(draft.fieldDisabled(zip, false)).toBe(false);
    expect(draft.checked(warning)).toBe(false);
    expect(draft.configurationDraft.ZipSaveData).toBe("YES");
  });
});

function entry(
  code: string,
  value: string,
  kind: ProjectConfigurationEntry["kind"],
): ProjectConfigurationEntry {
  return {
    code,
    japanese: code,
    english: code,
    value,
    default_value: value,
    effective_value: value,
    application: code === "SystemSaveInBinary" || code === "ZipSaveData" ? "restart" : "hot",
    kind,
    allowed: [],
    fixed: false,
    applicability: 12,
  };
}
