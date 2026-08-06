import { computed, reactive, ref, watch } from "vue";

import { availableProjectTabs, type SettingsField, type SettingsTabId } from "@/core/settings";
import {
  defaultPreferences,
  type Preferences,
  type ProjectConfigurationChange,
  type ProjectConfigurationEntry,
} from "@/core/types";

interface SettingsDraftOptions {
  open: () => boolean;
  preferences: () => Preferences;
  configurationEntries: () => ProjectConfigurationEntry[];
  configurationReadOnly: () => boolean;
  preview: (value: Preferences | null) => void;
}

export function useSettingsDraft(options: SettingsDraftOptions) {
  const draft = reactive<Preferences>({ ...options.preferences() });
  const configurationDraft = reactive<Record<string, string>>({});
  const fieldErrors = reactive<Record<string, string>>({});
  const activeTab = ref<SettingsTabId>("client");
  const projectTabs = computed(() => availableProjectTabs(options.configurationEntries()));
  const activeProjectTab = computed(() =>
    projectTabs.value.find((tab) => tab.id === activeTab.value),
  );
  const entries = computed(
    () => new Map(options.configurationEntries().map((entry) => [entry.code, entry])),
  );

  watch(
    options.open,
    (open) => {
      if (!open) return;
      resetAllDrafts();
      activeTab.value = projectTabs.value[0]?.id ?? "client";
    },
    { immediate: true },
  );
  watch(
    options.configurationEntries,
    () => {
      if (options.open()) resetConfigurationDraft();
    },
    { deep: true },
  );
  watch(draft, () => options.open() && options.preview(preferenceDraft()), { deep: true });

  function resetAllDrafts(): void {
    Object.assign(draft, options.preferences());
    resetConfigurationDraft();
    clearErrors();
  }

  function resetConfigurationDraft(): void {
    for (const code of Object.keys(configurationDraft)) delete configurationDraft[code];
    for (const entry of options.configurationEntries())
      configurationDraft[entry.code] = entry.value;
  }

  function preferenceDraft(): Preferences {
    const fontSize = draft.fontSizeOverridePx as number | string | null;
    return {
      ...draft,
      fontSizeOverridePx: fontSize == null || fontSize === "" ? null : Number(fontSize),
    };
  }

  function changes(): ProjectConfigurationChange[] {
    return options
      .configurationEntries()
      .filter(
        (entry) =>
          !options.configurationReadOnly() &&
          !entry.fixed &&
          configurationDraft[entry.code] !== entry.value,
      )
      .map((entry) => ({ code: entry.code, value: String(configurationDraft[entry.code]) }));
  }

  function validateAll(): boolean {
    clearErrors();
    for (const tab of projectTabs.value)
      for (const group of tab.groups) for (const field of group.fields) validateField(field);

    const fontSizeOverride = draft.fontSizeOverridePx as number | string | null;
    if (fontSizeOverride != null && fontSizeOverride !== "") {
      const size = Number(fontSizeOverride);
      if (!Number.isInteger(size) || size < 8 || size > 72)
        fieldErrors.clientFontSize = "字号必须是 8 到 72 的整数";
    }
    const fontSize = Number(configurationDraft.FontSize);
    const lineHeight = Number(configurationDraft.LineHeight);
    if (Number.isFinite(fontSize) && Number.isFinite(lineHeight) && lineHeight < fontSize)
      fieldErrors.LineHeight = "行高不能小于字号";

    const firstError = Object.keys(fieldErrors)[0];
    if (firstError) {
      const tab = projectTabs.value.find((item) =>
        item.groups.some((group) => group.fields.some((field) => field.code === firstError)),
      );
      activeTab.value = tab?.id ?? "client";
    }
    return firstError == null;
  }

  function validateField(field: SettingsField): void {
    const value = configurationDraft[field.code] ?? "";
    if (field.control === "number") {
      const parsed = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isInteger(parsed)) {
        fieldErrors[field.code] = "请输入整数";
        return;
      }
      if (parsed < -2_147_483_648 || parsed > 2_147_483_647) {
        fieldErrors[field.code] = "数值超出 32 位整数范围";
        return;
      }
      if (field.min != null && parsed < field.min)
        fieldErrors[field.code] = `最小值为 ${field.min}`;
      if (field.max != null && parsed > field.max)
        fieldErrors[field.code] = `最大值为 ${field.max}`;
    } else if ((field.control === "text" || field.control === "color") && !value.trim()) {
      fieldErrors[field.code] = "此项不能为空";
    }
  }

  function resetActiveTab(): void {
    if (activeTab.value === "client") {
      Object.assign(draft, defaultPreferences());
      clearErrors();
      return;
    }
    for (const group of activeProjectTab.value?.groups ?? [])
      for (const field of group.fields) {
        const entry = entries.value.get(field.code);
        if (entry && !entry.fixed && !options.configurationReadOnly())
          configurationDraft[field.code] = entry.default_value;
      }
    clearErrors();
  }

  function fieldDisabled(field: SettingsField, busy: boolean): boolean {
    const entry = entries.value.get(field.code);
    return (
      busy ||
      options.configurationReadOnly() ||
      Boolean(entry?.fixed) ||
      (field.code === "ZipSaveData" && configurationDraft.SystemSaveInBinary !== "YES") ||
      (field.code === "WarnFunctionOverloading" &&
        configurationDraft.AllowFunctionOverloading !== "YES")
    );
  }

  function checked(field: SettingsField): boolean {
    if (
      field.code === "WarnFunctionOverloading" &&
      configurationDraft.AllowFunctionOverloading !== "YES"
    )
      return true;
    return configurationDraft[field.code] === "YES";
  }

  function setBoolean(field: SettingsField, checked: boolean): void {
    configurationDraft[field.code] = checked ? "YES" : "NO";
  }

  function cancelDraft(): void {
    resetAllDrafts();
    options.preview(null);
  }

  function clearErrors(): void {
    for (const code of Object.keys(fieldErrors)) delete fieldErrors[code];
  }

  return {
    activeProjectTab,
    activeTab,
    checked,
    changes,
    configurationDraft,
    draft,
    entries,
    fieldDisabled,
    fieldErrors,
    preferenceDraft,
    projectTabs,
    resetActiveTab,
    setBoolean,
    validateAll,
    cancelDraft,
  };
}
