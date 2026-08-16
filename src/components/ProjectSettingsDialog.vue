<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import ColorPickerDialog from "@/components/ColorPickerDialog.vue";
import DraggableDialog from "@/components/DraggableDialog.vue";
import GameFontInput from "@/components/GameFontInput.vue";
import { useSettingsDraft } from "@/components/useSettingsDraft";
import type { SettingsField } from "@/core/settings";
import {
  type FontAccessStatus,
  type ProjectConfigurationChange,
  type ProjectConfigurationEntry,
} from "@/core/types";
import type { GameViewportMeasurement } from "@/platform/viewportMeasurement";

const props = withDefaults(
  defineProps<{
    open: boolean;
    fontFamilies: string[];
    fontAccessStatus?: FontAccessStatus;
    fontAccessError?: string;
    hostKind: "browser" | "tauri";
    viewportMeasurement?: GameViewportMeasurement;
    configurationEntries?: ProjectConfigurationEntry[];
    projectSource?: "directory" | "file";
    configurationReadOnly?: boolean;
    configurationSessionOnly?: boolean;
    restartPending?: boolean;
    busy?: boolean;
    error?: string;
  }>(),
  {
    configurationEntries: () => [],
    projectSource: "directory",
    fontAccessStatus: "idle",
    fontAccessError: "",
    configurationReadOnly: false,
    configurationSessionOnly: false,
    restartPending: false,
    busy: false,
    error: "",
  },
);
const emit = defineEmits<{
  close: [];
  requestFonts: [];
  save: [changes: ProjectConfigurationChange[], restart: boolean];
}>();
const colorField = ref<SettingsField>();
const {
  activeProjectTab,
  activeTabEditable,
  activeTab,
  anyFieldEditable,
  cancelDraft,
  checked,
  changes,
  configurationDraft,
  entries,
  fieldDisabled: draftFieldDisabled,
  fieldErrors,
  projectTabs,
  resetActiveTab,
  setBoolean: setDraftBoolean,
  validateAll,
} = useSettingsDraft({
  open: () => props.open,
  configurationEntries: () => props.configurationEntries,
  configurationReadOnly: () => props.configurationReadOnly,
  configurationSessionOnly: () => props.configurationSessionOnly,
});
const tabs = computed(() => projectTabs.value.map((tab) => ({ id: tab.id, label: tab.label })));
const canApply = computed(() => anyFieldEditable.value);
const title = computed(() => `RustyEra ${props.hostKind === "tauri" ? "Tauri" : "Web"} · 项目设置`);
const configurationWarning = computed(() => {
  if (props.configurationSessionOnly) {
    const source =
      props.projectSource === "file" ? "当前运行的是项目文件" : "当前项目文件夹无法直接写入";
    return `${source}；无需重启的设置仅对当前会话有效，退出游戏后将丢失。`;
  }
  if (!props.configurationReadOnly) return undefined;
  return props.projectSource === "file"
    ? "当前项目文件为只读，项目设置不可修改。"
    : "当前项目文件夹的设置为只读，项目设置不可修改。";
});

function close(): void {
  if (props.busy) return;
  cancelDraft();
  emit("close");
}

function apply(restart: boolean): void {
  if (!validateAll()) return;
  emit("save", changes(), restart);
}

function fieldDisabled(field: SettingsField): boolean {
  return draftFieldDisabled(field, props.busy);
}

function resetCurrentTab(): void {
  resetActiveTab();
}

function setBoolean(field: SettingsField, event: Event): void {
  setDraftBoolean(field, (event.target as HTMLInputElement).checked);
}

function settingItemClasses(field: SettingsField, groupTitle: string): Record<string, boolean> {
  return {
    "boolean-setting": field.control === "boolean",
    "long-label-setting": field.code === "ReplaceContinuationBR",
    "viewport-actions-setting": field.code === "WindowMaximixed" && props.hostKind === "tauri",
    "setting-wide":
      field.code === "AudioVolume" ||
      field.code === "ReplaceContinuationBR" ||
      (activeTab.value === "display" &&
        (groupTitle === "颜色" || field.code === "WindowMaximixed" || field.code === "FontName")),
  };
}

function useCurrentViewport(): void {
  if (!props.viewportMeasurement) return;
  configurationDraft.WindowX = String(Math.round(props.viewportMeasurement.width));
  configurationDraft.WindowY = String(Math.round(props.viewportMeasurement.height));
}

async function tabKeydown(event: KeyboardEvent): Promise<void> {
  if (tabs.value.length === 0) return;
  const index = tabs.value.findIndex((tab) => tab.id === activeTab.value);
  let next = index;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.value.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.value.length) % tabs.value.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.value.length - 1;
  else return;
  event.preventDefault();
  activeTab.value = tabs.value[next]?.id ?? "interaction";
  await nextTick();
  document.querySelector<HTMLElement>(`#settings-tab-${activeTab.value}`)?.focus();
}
</script>

<template>
  <DraggableDialog
    :open="open"
    :title="title"
    panel-class="settings-panel"
    :close-disabled="busy"
    @close="close"
  >
    <form class="settings-dialog" @submit.prevent="apply(false)">
      <div class="settings-tabs" role="tablist" aria-label="设置分类" @keydown="tabKeydown">
        <button
          v-for="tab in tabs"
          :id="`settings-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`settings-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div
        :id="`settings-panel-${activeTab}`"
        class="settings-scroll"
        role="tabpanel"
        :aria-labelledby="`settings-tab-${activeTab}`"
      >
        <template v-if="activeProjectTab">
          <p v-if="activeProjectTab.warning" class="settings-warning" role="note">
            {{ activeProjectTab.warning }}
          </p>
          <p v-if="configurationWarning" class="settings-warning" role="note">
            {{ configurationWarning }}
          </p>

          <p v-if="restartPending" class="settings-warning" role="note">
            当前有设置将在重新启动项目后生效。
          </p>

          <fieldset v-if="activeTab === 'display' && hostKind === 'browser'" class="settings-group">
            <legend>当前主视口</legend>
            <div class="settings-grid viewport-readout">
              <div class="setting-item">
                <span>主视口宽度</span>
                <output>{{
                  viewportMeasurement ? Math.round(viewportMeasurement.width) : "—"
                }}</output>
              </div>
              <div class="setting-item">
                <span>主视口高度</span>
                <output>{{
                  viewportMeasurement ? Math.round(viewportMeasurement.height) : "—"
                }}</output>
              </div>
            </div>
          </fieldset>

          <fieldset
            v-for="group in activeProjectTab.groups"
            :key="group.title"
            class="settings-group"
          >
            <legend>{{ group.title }}</legend>
            <div class="settings-grid" :class="{ 'color-settings-grid': group.title === '颜色' }">
              <div
                v-for="field in group.fields"
                :key="field.code"
                class="setting-item"
                :class="settingItemClasses(field, group.title)"
              >
                <template v-if="field.control === 'boolean'">
                  <label :for="`setting-${field.code}`" :title="field.description">
                    <input
                      :id="`setting-${field.code}`"
                      type="checkbox"
                      :checked="checked(field)"
                      :disabled="fieldDisabled(field)"
                      @change="setBoolean(field, $event)"
                    />
                    <span>{{ field.label }}</span>
                    <small v-if="entries.get(field.code)?.fixed">已固定</small>
                  </label>
                  <button
                    v-if="field.code === 'WindowMaximixed' && hostKind === 'tauri'"
                    type="button"
                    class="viewport-size-button"
                    title="将当前主视口宽高填入下方尺寸设置。"
                    :disabled="
                      busy ||
                      (configurationReadOnly && !configurationSessionOnly) ||
                      !viewportMeasurement
                    "
                    @click="useCurrentViewport"
                  >
                    使用当前主视口大小
                  </button>
                </template>
                <label v-else :for="`setting-${field.code}`" :title="field.description">
                  {{ field.label }}<small v-if="entries.get(field.code)?.fixed">已固定</small>
                </label>
                <div v-if="field.control !== 'boolean'" class="setting-control">
                  <select
                    v-if="field.control === 'enum'"
                    :id="`setting-${field.code}`"
                    v-model="configurationDraft[field.code]"
                    :disabled="fieldDisabled(field)"
                  >
                    <option
                      v-for="option in field.options ??
                      entries.get(field.code)?.allowed.map((value) => ({ value, label: value }))"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                  <button
                    v-else-if="field.control === 'color'"
                    :id="`setting-${field.code}`"
                    type="button"
                    class="color-setting"
                    :disabled="fieldDisabled(field)"
                    @click="colorField = field"
                  >
                    <span
                      class="color-setting-swatch"
                      :style="{ backgroundColor: `rgb(${configurationDraft[field.code]})` }"
                    />
                    <span class="color-setting-value">{{ configurationDraft[field.code] }}</span>
                  </button>
                  <GameFontInput
                    v-else-if="field.code === 'FontName'"
                    :id="`setting-${field.code}`"
                    v-model="configurationDraft[field.code]"
                    :font-families="fontFamilies"
                    :status="fontAccessStatus"
                    :error="fontAccessError"
                    :host-kind="hostKind"
                    :disabled="fieldDisabled(field)"
                    @request-fonts="emit('requestFonts')"
                  />
                  <div v-else-if="field.control === 'range'" class="range-setting-control">
                    <input
                      :id="`setting-${field.code}`"
                      v-model="configurationDraft[field.code]"
                      type="range"
                      :min="field.min"
                      :max="field.max"
                      step="1"
                      :disabled="fieldDisabled(field)"
                    />
                    <output :for="`setting-${field.code}`">
                      {{ configurationDraft[field.code] }}%
                    </output>
                  </div>
                  <input
                    v-else
                    :id="`setting-${field.code}`"
                    v-model="configurationDraft[field.code]"
                    :type="field.control === 'number' ? 'number' : 'text'"
                    :min="field.min"
                    :max="field.max"
                    :disabled="fieldDisabled(field)"
                  />
                  <p v-if="fieldErrors[field.code]" class="field-error" role="alert">
                    {{ fieldErrors[field.code] }}
                  </p>
                </div>
              </div>
            </div>
          </fieldset>
          <datalist id="available-game-fonts">
            <option v-for="font in fontFamilies" :key="font" :value="font" />
          </datalist>
        </template>
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions settings-actions">
        <button type="button" :disabled="busy || !activeTabEditable" @click="resetCurrentTab">
          重置当前标签页
        </button>
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="close">取消</button>
        <button type="submit" class="primary" :disabled="busy || !canApply">
          {{ busy ? "正在应用…" : "应用" }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="busy || configurationSessionOnly || configurationReadOnly"
          @click="apply(true)"
        >
          应用并重启
        </button>
      </footer>
    </form>
  </DraggableDialog>

  <ColorPickerDialog
    :open="Boolean(colorField)"
    :title="colorField ? `选择${colorField.label}` : '选择颜色'"
    :value="colorField ? configurationDraft[colorField.code] : '0,0,0'"
    @close="colorField = undefined"
    @confirm="
      (value) => {
        if (colorField) configurationDraft[colorField.code] = value;
        colorField = undefined;
      }
    "
  />
</template>
