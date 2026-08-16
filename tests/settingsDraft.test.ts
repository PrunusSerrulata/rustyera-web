import { nextTick, reactive } from "vue";
import { describe, expect, it } from "vitest";

import { useSettingsDraft } from "@/components/useSettingsDraft";
import { availableProjectTabs, projectSettingsTabs, type SettingsField } from "@/core/settings";
import type { ProjectConfigurationEntry } from "@/core/types";

describe("settings draft domain", () => {
  it("separates audio from output-text settings and describes every field", () => {
    const groups = projectSettingsTabs.find((tab) => tab.id === "interaction")?.groups;
    const audio = groups?.find((group) => group.title === "声音")?.fields;
    const outputText = groups?.find((group) => group.title === "输出文本")?.fields;

    expect(audio?.map((field) => field.code)).toEqual(["AudioVolume"]);
    expect(audio?.[0]?.control).toBe("range");
    expect(outputText?.map((field) => field.code)).toEqual([
      "ReplaceFullWidthSpaces",
      "CharacterWidthMode",
    ]);
    expect(
      projectSettingsTabs
        .flatMap((tab) => tab.groups)
        .flatMap((group) => group.fields)
        .every((field) => field.description.trim().length > 0),
    ).toBe(true);

    expect(availableProjectTabs([entry("AudioVolume", "100", "integer")])[0]?.groups).toEqual([
      expect.objectContaining({
        title: "声音",
        fields: [expect.objectContaining({ code: "AudioVolume" })],
      }),
    ]);
    expect(
      availableProjectTabs([
        entry("ReplaceFullWidthSpaces", "NO", "boolean"),
        entry("CharacterWidthMode", "AUTOMATIC", "enum"),
      ])[0]?.groups,
    ).toEqual([
      expect.objectContaining({
        title: "输出文本",
        fields: [
          expect.objectContaining({ code: "ReplaceFullWidthSpaces" }),
          expect.objectContaining({ code: "CharacterWidthMode" }),
        ],
      }),
    ]);
  });

  it("describes FocusColor as the selected text color", () => {
    const focusColor = projectSettingsTabs
      .flatMap((tab) => tab.groups)
      .flatMap((group) => group.fields)
      .find((field) => field.code === "FocusColor");

    expect(focusColor?.label).toBe("选中文字颜色");
  });

  it("collects changes across tabs, locates validation errors, and rolls edits back", async () => {
    const state = reactive({
      open: false,
      readOnly: false,
      entries: [
        entry("UseMouse", "YES", "boolean"),
        entry("FontSize", "18", "integer"),
        entry("LineHeight", "19", "integer"),
      ] as ProjectConfigurationEntry[],
    });
    const draft = useSettingsDraft({
      open: () => state.open,
      configurationEntries: () => state.entries,
      configurationReadOnly: () => state.readOnly,
      configurationSessionOnly: () => false,
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

    draft.cancelDraft();
    expect(draft.configurationDraft.UseMouse).toBe("YES");
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
      configurationEntries: () => state.entries,
      configurationReadOnly: () => false,
      configurationSessionOnly: () => false,
    });
    state.open = true;
    await nextTick();
    const zip: SettingsField = {
      code: "ZipSaveData",
      label: "压缩",
      description: "压缩存档。",
      control: "boolean",
    };
    const warning: SettingsField = {
      code: "WarnFunctionOverloading",
      label: "警告",
      description: "显示警告。",
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

  it("allows only hot fields in a read-only project-file session", async () => {
    const state = reactive({
      open: false,
      entries: [
        entry("UseMouse", "YES", "boolean"),
        entry("AutoSave", "YES", "boolean", "restart"),
      ] as ProjectConfigurationEntry[],
    });
    const draft = useSettingsDraft({
      open: () => state.open,
      configurationEntries: () => state.entries,
      configurationReadOnly: () => true,
      configurationSessionOnly: () => true,
    });
    state.open = true;
    await nextTick();
    const useMouse: SettingsField = {
      code: "UseMouse",
      label: "鼠标",
      description: "启用鼠标。",
      control: "boolean",
    };
    const autoSave: SettingsField = {
      code: "AutoSave",
      label: "自动保存",
      description: "启用自动保存。",
      control: "boolean",
    };

    expect(draft.fieldDisabled(useMouse, false)).toBe(false);
    expect(draft.fieldDisabled(autoSave, false)).toBe(true);
    draft.configurationDraft.UseMouse = "NO";
    draft.configurationDraft.AutoSave = "NO";
    expect(draft.changes()).toEqual([{ code: "UseMouse", value: "NO" }]);
  });
});

function entry(
  code: string,
  value: string,
  kind: ProjectConfigurationEntry["kind"],
  application: ProjectConfigurationEntry["application"] = code === "SystemSaveInBinary" ||
  code === "ZipSaveData"
    ? "restart"
    : "hot",
): ProjectConfigurationEntry {
  return {
    code,
    japanese: code,
    english: code,
    value,
    default_value: value,
    effective_value: value,
    preference_eligible: true,
    client_effective_value: value,
    application,
    kind,
    allowed: [],
    fixed: false,
    applicability: 12,
  };
}
