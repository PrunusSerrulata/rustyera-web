import { computed, reactive, ref, watch } from "vue";

import { availableProjectTabs, type SettingsField, type SettingsTabId } from "@/core/settings";
import type { ProjectConfigurationChange, ProjectConfigurationEntry } from "@/core/types";

interface SettingsDraftOptions {
  open: () => boolean;
  configurationEntries: () => ProjectConfigurationEntry[];
  configurationReadOnly: () => boolean;
  configurationSessionOnly: () => boolean;
}

export function useSettingsDraft(options: SettingsDraftOptions) {
  const configurationDraft = reactive<Record<string, string>>({});
  const fieldErrors = reactive<Record<string, string>>({});
  const activeTab = ref<SettingsTabId>("interaction");
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
      activeTab.value = projectTabs.value[0]?.id ?? "interaction";
    },
    { immediate: true },
  );
  watch(
    options.configurationEntries,
    () => {
      if (!options.open()) return;
      resetConfigurationDraft();
      if (!projectTabs.value.some((tab) => tab.id === activeTab.value))
        activeTab.value = projectTabs.value[0]?.id ?? "interaction";
    },
    { deep: true },
  );
  function resetAllDrafts(): void {
    resetConfigurationDraft();
    clearErrors();
  }

  function resetConfigurationDraft(): void {
    for (const code of Object.keys(configurationDraft)) delete configurationDraft[code];
    for (const entry of options.configurationEntries())
      configurationDraft[entry.code] = entry.value;
  }

  function changes(): ProjectConfigurationChange[] {
    return options
      .configurationEntries()
      .filter((entry) => entryEditable(entry) && configurationDraft[entry.code] !== entry.value)
      .map((entry) => ({ code: entry.code, value: String(configurationDraft[entry.code]) }));
  }

  function validateAll(): boolean {
    clearErrors();
    for (const tab of projectTabs.value)
      for (const group of tab.groups) for (const field of group.fields) validateField(field);

    const fontSize = Number(configurationDraft.FontSize);
    const lineHeight = Number(configurationDraft.LineHeight);
    if (Number.isFinite(fontSize) && Number.isFinite(lineHeight) && lineHeight < fontSize)
      fieldErrors.LineHeight = "行高不能小于字号";

    const firstError = Object.keys(fieldErrors)[0];
    if (firstError) {
      const tab = projectTabs.value.find((item) =>
        item.groups.some((group) => group.fields.some((field) => field.code === firstError)),
      );
      activeTab.value = tab?.id ?? "interaction";
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
    for (const group of activeProjectTab.value?.groups ?? [])
      for (const field of group.fields) {
        const entry = entries.value.get(field.code);
        if (entry && entryEditable(entry)) configurationDraft[field.code] = entry.default_value;
      }
    clearErrors();
  }

  function fieldDisabled(field: SettingsField, busy: boolean): boolean {
    const entry = entries.value.get(field.code);
    return (
      busy ||
      !entry ||
      !entryEditable(entry) ||
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
  }

  function entryEditable(entry: ProjectConfigurationEntry): boolean {
    if (entry.fixed) return false;
    if (!options.configurationReadOnly()) return true;
    return options.configurationSessionOnly() && entry.application === "hot";
  }

  const activeTabEditable = computed(() =>
    (activeProjectTab.value?.groups ?? []).some((group) =>
      group.fields.some((field) => {
        const entry = entries.value.get(field.code);
        return entry != null && entryEditable(entry);
      }),
    ),
  );
  const anyFieldEditable = computed(() => options.configurationEntries().some(entryEditable));

  function clearErrors(): void {
    for (const code of Object.keys(fieldErrors)) delete fieldErrors[code];
  }

  return {
    activeProjectTab,
    activeTabEditable,
    activeTab,
    anyFieldEditable,
    checked,
    changes,
    configurationDraft,
    entries,
    fieldDisabled,
    fieldErrors,
    projectTabs,
    resetActiveTab,
    setBoolean,
    validateAll,
    cancelDraft,
  };
}
