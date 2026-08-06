<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import ColorPickerDialog from "@/components/ColorPickerDialog.vue";
import DraggableDialog from "@/components/DraggableDialog.vue";
import { useSettingsDraft } from "@/components/useSettingsDraft";
import type { SettingsField } from "@/core/settings";
import {
  type Preferences,
  type ProjectConfigurationChange,
  type ProjectConfigurationEntry,
} from "@/core/types";
import type { GameViewportMeasurement } from "@/platform/viewportMeasurement";

const props = withDefaults(
  defineProps<{
    open: boolean;
    value: Preferences;
    fonts: string[];
    hostKind: "browser" | "tauri";
    viewportMeasurement?: GameViewportMeasurement;
    configurationEntries?: ProjectConfigurationEntry[];
    configurationReadOnly?: boolean;
    restartPending?: boolean;
    busy?: boolean;
    error?: string;
  }>(),
  {
    configurationEntries: () => [],
    configurationReadOnly: false,
    restartPending: false,
    busy: false,
    error: "",
  },
);
const emit = defineEmits<{
  close: [];
  save: [value: Preferences, changes: ProjectConfigurationChange[], restart: boolean];
  preview: [value: Preferences | null];
}>();
const colorField = ref<SettingsField>();
const {
  activeProjectTab,
  activeTab,
  cancelDraft,
  checked,
  changes,
  configurationDraft,
  draft,
  entries,
  fieldDisabled: draftFieldDisabled,
  fieldErrors,
  preferenceDraft,
  projectTabs,
  resetActiveTab,
  setBoolean: setDraftBoolean,
  validateAll,
} = useSettingsDraft({
  open: () => props.open,
  preferences: () => props.value,
  configurationEntries: () => props.configurationEntries,
  configurationReadOnly: () => props.configurationReadOnly,
  preview: (value) => emit("preview", value),
});
const tabs = computed(() => [
  ...projectTabs.value.map((tab) => ({ id: tab.id, label: tab.label })),
  { id: "client" as const, label: "客户端偏好" },
]);
const title = computed(() => `RustyEra ${props.hostKind === "tauri" ? "Tauri" : "Web"} · 设置`);

function close(): void {
  if (props.busy) return;
  cancelDraft();
  emit("close");
}

function apply(restart: boolean): void {
  if (!validateAll()) return;
  emit("save", preferenceDraft(), changes(), restart);
}

function fieldDisabled(field: SettingsField): boolean {
  return draftFieldDisabled(field, props.busy);
}

function setBoolean(field: SettingsField, event: Event): void {
  setDraftBoolean(field, (event.target as HTMLInputElement).checked);
}

function useCurrentViewport(): void {
  if (!props.viewportMeasurement) return;
  configurationDraft.WindowX = String(Math.round(props.viewportMeasurement.width));
  configurationDraft.WindowY = String(Math.round(props.viewportMeasurement.height));
}

async function tabKeydown(event: KeyboardEvent): Promise<void> {
  const index = tabs.value.findIndex((tab) => tab.id === activeTab.value);
  let next = index;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.value.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.value.length) % tabs.value.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.value.length - 1;
  else return;
  event.preventDefault();
  activeTab.value = tabs.value[next]?.id ?? "client";
  await nextTick();
  document.querySelector<HTMLElement>(`#settings-tab-${activeTab.value}`)?.focus();
}
</script>

<template>
  <DraggableDialog :open="open" :title="title" wide :close-disabled="busy" @close="close">
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
          <p v-if="configurationReadOnly" class="settings-warning" role="note">
            当前项目文件为只读，项目设置不可修改。
          </p>

          <p v-if="restartPending" class="settings-warning" role="note">
            当前有设置将在重新启动项目后生效。
          </p>

          <fieldset v-if="activeTab === 'display' && hostKind === 'browser'" class="settings-group">
            <legend>当前主视口</legend>
            <div class="settings-grid viewport-readout">
              <span>宽度</span
              ><output>{{
                viewportMeasurement ? Math.round(viewportMeasurement.width) : "—"
              }}</output>
              <span>高度</span
              ><output>{{
                viewportMeasurement ? Math.round(viewportMeasurement.height) : "—"
              }}</output>
            </div>
          </fieldset>

          <fieldset
            v-for="group in activeProjectTab.groups"
            :key="group.title"
            class="settings-group"
          >
            <legend>{{ group.title }}</legend>
            <div class="settings-grid">
              <template v-for="field in group.fields" :key="field.code">
                <label :for="`setting-${field.code}`" :title="field.code">
                  {{ field.label }}<small v-if="entries.get(field.code)?.fixed">已固定</small>
                </label>
                <div class="setting-control">
                  <input
                    v-if="field.control === 'boolean'"
                    :id="`setting-${field.code}`"
                    type="checkbox"
                    :checked="checked(field)"
                    :disabled="fieldDisabled(field)"
                    @change="setBoolean(field, $event)"
                  />
                  <select
                    v-else-if="field.control === 'enum'"
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
                  <input
                    v-else
                    :id="`setting-${field.code}`"
                    v-model="configurationDraft[field.code]"
                    :type="field.control === 'number' ? 'number' : 'text'"
                    :min="field.min"
                    :max="field.max"
                    :list="field.code === 'FontName' ? 'available-game-fonts' : undefined"
                    :disabled="fieldDisabled(field)"
                  />
                  <p v-if="fieldErrors[field.code]" class="field-error" role="alert">
                    {{ fieldErrors[field.code] }}
                  </p>
                </div>
              </template>
            </div>
            <button
              v-if="
                activeTab === 'display' && group.title === '窗口与主视口' && hostKind === 'tauri'
              "
              type="button"
              :disabled="busy || configurationReadOnly || !viewportMeasurement"
              @click="useCurrentViewport"
            >
              使用当前主视口大小
            </button>
          </fieldset>
          <datalist id="available-game-fonts">
            <option v-for="font in fonts" :key="font" :value="font" />
          </datalist>
        </template>

        <template v-else>
          <fieldset class="settings-group">
            <legend>游戏文本</legend>
            <div class="settings-grid">
              <label for="client-font-family">字体</label>
              <select id="client-font-family" v-model="draft.fontFamilyOverride" :disabled="busy">
                <option :value="null">跟随游戏设置</option>
                <option v-for="font in fonts" :key="font" :value="font">{{ font }}</option>
              </select>
              <label for="client-font-size">字号</label>
              <div class="setting-control">
                <input
                  id="client-font-size"
                  v-model.number="draft.fontSizeOverridePx"
                  type="number"
                  min="8"
                  max="72"
                  step="1"
                  placeholder="跟随游戏设置"
                  :disabled="busy"
                />
                <p v-if="fieldErrors.clientFontSize" class="field-error" role="alert">
                  {{ fieldErrors.clientFontSize }}
                </p>
              </div>
            </div>
          </fieldset>
          <fieldset class="settings-group">
            <legend>媒体</legend>
            <div class="settings-grid">
              <label for="client-image-scale">图片缩放</label>
              <div class="inline-field">
                <input
                  id="client-image-scale"
                  v-model.number="draft.imageScale"
                  type="range"
                  min="0.25"
                  max="4"
                  step="0.05"
                  :disabled="busy"
                />
                <output>{{ Math.round(draft.imageScale * 100) }}%</output>
              </div>
              <label for="client-volume">音量</label>
              <div class="inline-field">
                <input
                  id="client-volume"
                  v-model.number="draft.masterVolume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  :disabled="busy"
                />
                <output>{{ Math.round(draft.masterVolume * 100) }}%</output>
              </div>
            </div>
          </fieldset>
        </template>
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions settings-actions">
        <button type="button" :disabled="busy" @click="resetActiveTab">重置当前标签页</button>
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="close">取消</button>
        <button type="submit" class="primary" :disabled="busy">
          {{ busy ? "正在应用…" : "应用" }}
        </button>
        <button type="button" class="primary" :disabled="busy" @click="apply(true)">
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
