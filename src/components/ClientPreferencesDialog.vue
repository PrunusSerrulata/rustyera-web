<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";

import ColorPickerDialog from "@/components/ColorPickerDialog.vue";
import DraggableDialog from "@/components/DraggableDialog.vue";
import { projectSettingsTabs, type SettingsField } from "@/core/settings";
import type { Preferences, ProjectConfigurationEntry, ProjectPreferences } from "@/core/types";

const props = withDefaults(
  defineProps<{
    open: boolean;
    globalValue: Preferences;
    projectValue: ProjectPreferences;
    entries: ProjectConfigurationEntry[];
    hostKind?: "browser" | "tauri";
    projectWritable?: boolean;
    busy?: boolean;
    error?: string;
  }>(),
  { hostKind: "browser", projectWritable: false, busy: false, error: "" },
);
const emit = defineEmits<{
  close: [];
  save: [scope: "global" | "project", value: ProjectPreferences];
}>();

const scope = ref<"global" | "project">("global");
const draft = reactive<ProjectPreferences>({ settings: {} });
const colorField = ref<SettingsField>();
const browserPreferenceDefaults: Record<string, string> = {
  UseMenu: "YES",
  UseMouse: "YES",
  ScrollHeight: "1",
  ButtonWrap: "NO",
  FontName: "ＭＳ ゴシック",
  FontSize: "18",
  LineHeight: "19",
  ForeColor: "192,192,192",
  BackColor: "0,0,0",
  FocusColor: "255,255,0",
  AudioVolume: "100",
  ReplaceFullWidthSpaces: "NO",
};
const preProjectDefaults = computed<Record<string, string>>(() => {
  if (props.projectWritable || props.entries.length > 0) return {};
  if (props.hostKind === "browser") return browserPreferenceDefaults;
  return {
    ...browserPreferenceDefaults,
    WindowMaximixed: "NO",
    WindowX: "760",
    WindowY: "480",
  };
});
const eligibleEntries = computed(() => props.entries.filter((entry) => entry.preference_eligible));
const entryMap = computed(() => new Map(eligibleEntries.value.map((entry) => [entry.code, entry])));
const visibleCodes = computed(
  () =>
    new Set([
      ...eligibleEntries.value.map((entry) => entry.code),
      ...Object.keys(preProjectDefaults.value),
      ...Object.keys(props.globalValue.settings),
      ...Object.keys(props.projectValue.settings),
    ]),
);
const groups = computed(() => {
  const visible = visibleCodes.value;
  return projectSettingsTabs
    .flatMap((tab) => tab.groups)
    .map((group) => ({
      ...group,
      fields: group.fields.filter((field) => visible.has(field.code)),
    }))
    .filter((group) => group.fields.length > 0);
});
const title = computed(() => `RustyEra ${props.hostKind === "tauri" ? "Tauri" : "Web"} · 偏好设置`);
const auxiliaryDescriptions = {
  imageScale: "调整游戏图片和画布在当前客户端中的显示缩放比例。",
  trustProjectFileMetadata: "允许快速启动使用文件大小和修改时间判断项目文件是否变化。",
} as const;

watch(
  [
    () => props.open,
    scope,
    () => props.globalValue,
    () => props.projectValue,
    () => props.projectWritable,
  ],
  ([open]) => {
    if (!open) return;
    if (!props.projectWritable && scope.value === "project") scope.value = "global";
    resetDraft();
  },
  { immediate: true, deep: true },
);

function source(): ProjectPreferences {
  return scope.value === "global"
    ? {
        settings: props.globalValue.settings,
        imageScale: props.globalValue.imageScale,
        masterVolume: props.globalValue.masterVolume,
        trustProjectFileMetadata: props.globalValue.trustProjectFileMetadata,
      }
    : props.projectValue;
}

function resetDraft(): void {
  const value = source();
  draft.settings = { ...value.settings };
  draft.imageScale = value.imageScale;
  draft.masterVolume = value.masterVolume;
  draft.trustProjectFileMetadata = value.trustProjectFileMetadata;
}

function overridden(code: string): boolean {
  return Reflect.has(draft.settings, code) && Object.hasOwn(draft.settings, code);
}

function toggle(field: SettingsField, enabled: boolean): void {
  if (enabled) {
    const entry = entryMap.value.get(field.code);
    draft.settings[field.code] =
      entry?.client_effective_value ??
      entry?.effective_value ??
      source().settings[field.code] ??
      preProjectDefaults.value[field.code] ??
      "";
  } else {
    delete draft.settings[field.code];
  }
}

function booleanValue(code: string): boolean {
  return ["YES", "TRUE", "1"].includes(draft.settings[code]?.toUpperCase() ?? "");
}

function setBoolean(code: string, checked: boolean): void {
  draft.settings[code] = checked ? "YES" : "NO";
}

function auxiliaryOverridden(key: "imageScale" | "trustProjectFileMetadata") {
  return scope.value === "global" || draft[key] != null;
}

function toggleAuxiliary(key: "imageScale" | "trustProjectFileMetadata", enabled: boolean): void {
  if (key === "imageScale") {
    draft.imageScale = !enabled && scope.value === "project" ? undefined : 1;
  } else {
    draft.trustProjectFileMetadata = !enabled && scope.value === "project" ? undefined : false;
  }
}

function settingItemClasses(field: SettingsField): Record<string, boolean> {
  return {
    "preference-color-setting": field.control === "color",
    "setting-wide":
      field.control === "color" ||
      ["AudioVolume", "ReplaceContinuationBR", "WindowMaximixed", "FontName"].includes(field.code),
  };
}

function save(): void {
  emit("save", scope.value, {
    settings: { ...draft.settings },
    imageScale: draft.imageScale,
    masterVolume: draft.masterVolume,
    trustProjectFileMetadata: draft.trustProjectFileMetadata,
  });
}

async function scopeKeydown(event: KeyboardEvent): Promise<void> {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Home" || event.key === "ArrowLeft") scope.value = "global";
  else if (props.projectWritable) scope.value = "project";
  await nextTick();
  document.querySelector<HTMLElement>(`#preference-tab-${scope.value}`)?.focus();
}
</script>

<template>
  <DraggableDialog
    :open="open"
    :title="title"
    panel-class="settings-panel"
    :close-disabled="busy"
    @close="emit('close')"
  >
    <form class="settings-dialog" @submit.prevent="save">
      <div class="settings-tabs" role="tablist" aria-label="偏好作用域" @keydown="scopeKeydown">
        <button
          id="preference-tab-global"
          type="button"
          role="tab"
          :aria-selected="scope === 'global'"
          aria-controls="preference-panel-global"
          :tabindex="scope === 'global' ? 0 : -1"
          title="编辑与具体项目无关、适用于此客户端的默认偏好。"
          @click="scope = 'global'"
        >
          全局偏好
        </button>
        <button
          id="preference-tab-project"
          type="button"
          role="tab"
          :aria-selected="scope === 'project'"
          aria-controls="preference-panel-project"
          :tabindex="scope === 'project' ? 0 : -1"
          :disabled="!projectWritable"
          title="编辑当前项目在此客户端中的专用偏好。"
          @click="scope = 'project'"
        >
          项目偏好
        </button>
      </div>

      <div
        :id="`preference-panel-${scope}`"
        class="settings-scroll"
        role="tabpanel"
        :aria-labelledby="`preference-tab-${scope}`"
      >
        <p class="settings-warning" role="note">
          项目偏好优先于项目设置，全局偏好仅在项目没有明确设置时生效。偏好只影响当前客户端显示与交互，不改变游戏逻辑。
        </p>
        <fieldset v-for="group in groups" :key="group.title" class="settings-group">
          <legend>{{ group.title }}</legend>
          <div class="settings-grid">
            <div
              v-for="field in group.fields"
              :key="field.code"
              class="setting-item preference-setting-item"
              :class="settingItemClasses(field)"
            >
              <label
                class="preference-setting-label"
                :for="`preference-${scope}-${field.code}-override`"
                :title="field.description"
                :aria-description="field.description"
              >
                <input
                  :id="`preference-${scope}-${field.code}-override`"
                  type="checkbox"
                  :checked="overridden(field.code)"
                  :disabled="busy"
                  @change="toggle(field, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ field.label }}</span>
                <small>{{ overridden(field.code) ? "已覆盖" : "继承" }}</small>
              </label>
              <div
                v-if="field.control === 'color' || overridden(field.code)"
                class="setting-control preference-setting-control"
              >
                <label
                  v-if="field.control === 'boolean'"
                  class="preference-boolean-control"
                  :for="`preference-${scope}-${field.code}`"
                  :title="field.description"
                >
                  <input
                    :id="`preference-${scope}-${field.code}`"
                    type="checkbox"
                    :checked="booleanValue(field.code)"
                    :disabled="busy || !overridden(field.code)"
                    @change="setBoolean(field.code, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>启用</span>
                </label>
                <select
                  v-else-if="field.control === 'enum'"
                  :id="`preference-${scope}-${field.code}`"
                  v-model="draft.settings[field.code]"
                  :disabled="busy || !overridden(field.code)"
                >
                  <option
                    v-for="option in field.options ??
                    entryMap.get(field.code)?.allowed.map((value) => ({ value, label: value })) ??
                    []"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <button
                  v-else-if="field.control === 'color'"
                  :id="`preference-${scope}-${field.code}`"
                  type="button"
                  class="color-setting"
                  :disabled="busy || !overridden(field.code)"
                  :title="field.description"
                  @click="colorField = field"
                >
                  <span
                    class="color-setting-swatch"
                    :style="{ backgroundColor: `rgb(${draft.settings[field.code]})` }"
                  />
                  <span class="color-setting-value">{{ draft.settings[field.code] }}</span>
                </button>
                <div v-else-if="field.control === 'range'" class="range-setting-control">
                  <input
                    :id="`preference-${scope}-${field.code}`"
                    :value="draft.settings[field.code]"
                    type="range"
                    :min="field.min"
                    :max="field.max"
                    step="1"
                    :disabled="busy || !overridden(field.code)"
                    @input="draft.settings[field.code] = ($event.target as HTMLInputElement).value"
                  />
                  <output :for="`preference-${scope}-${field.code}`">
                    {{ draft.settings[field.code] }}%
                  </output>
                </div>
                <input
                  v-else
                  :id="`preference-${scope}-${field.code}`"
                  :value="draft.settings[field.code]"
                  :type="field.control === 'number' ? 'number' : 'text'"
                  :min="field.min"
                  :max="field.max"
                  :disabled="busy || !overridden(field.code)"
                  @input="draft.settings[field.code] = ($event.target as HTMLInputElement).value"
                />
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>客户端显示与项目加载</legend>
          <div class="settings-grid">
            <div
              class="setting-item preference-auxiliary-item"
              :class="{ 'preference-has-override': scope === 'project' }"
            >
              <label
                class="preference-auxiliary-label"
                :for="scope === 'global' ? `preference-${scope}-imageScale` : undefined"
                :title="auxiliaryDescriptions.imageScale"
                :aria-description="auxiliaryDescriptions.imageScale"
              >
                <input
                  v-if="scope === 'project'"
                  :id="`preference-${scope}-imageScale-override`"
                  type="checkbox"
                  :checked="auxiliaryOverridden('imageScale')"
                  :disabled="busy"
                  @change="
                    toggleAuxiliary('imageScale', ($event.target as HTMLInputElement).checked)
                  "
                />
                <span>图片缩放</span>
              </label>
              <div
                v-if="auxiliaryOverridden('imageScale')"
                class="setting-control preference-setting-control"
              >
                <input
                  :id="`preference-${scope}-imageScale`"
                  v-model.number="draft.imageScale"
                  type="number"
                  min="0.25"
                  max="4"
                  step="0.05"
                  :disabled="busy || !auxiliaryOverridden('imageScale')"
                />
              </div>
            </div>
            <div class="setting-item setting-wide preference-metadata-setting">
              <label
                class="preference-auxiliary-label"
                :for="
                  scope === 'global' ? `preference-${scope}-trustProjectFileMetadata` : undefined
                "
                :title="auxiliaryDescriptions.trustProjectFileMetadata"
                :aria-description="auxiliaryDescriptions.trustProjectFileMetadata"
              >
                <input
                  v-if="scope === 'project'"
                  :id="`preference-${scope}-trustProjectFileMetadata-override`"
                  type="checkbox"
                  :checked="auxiliaryOverridden('trustProjectFileMetadata')"
                  :disabled="busy"
                  @change="
                    toggleAuxiliary(
                      'trustProjectFileMetadata',
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
                <span>快速启动文件元数据</span>
              </label>
              <label
                v-if="auxiliaryOverridden('trustProjectFileMetadata')"
                class="setting-control preference-boolean-control"
                :for="`preference-${scope}-trustProjectFileMetadata`"
                :title="auxiliaryDescriptions.trustProjectFileMetadata"
              >
                <input
                  :id="`preference-${scope}-trustProjectFileMetadata`"
                  v-model="draft.trustProjectFileMetadata"
                  type="checkbox"
                  :disabled="busy || !auxiliaryOverridden('trustProjectFileMetadata')"
                />
                <span>信任大小和修改时间</span>
              </label>
            </div>
          </div>
        </fieldset>
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions settings-actions">
        <button type="button" :disabled="busy" @click="resetDraft">重置未保存更改</button>
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="busy">
          {{ busy ? "正在应用…" : "应用" }}
        </button>
      </footer>
    </form>
  </DraggableDialog>

  <ColorPickerDialog
    :open="Boolean(colorField)"
    :title="colorField ? `选择${colorField.label}` : '选择颜色'"
    :value="colorField ? draft.settings[colorField.code] : '0,0,0'"
    @close="colorField = undefined"
    @confirm="
      (value) => {
        if (colorField) draft.settings[colorField.code] = value;
        colorField = undefined;
      }
    "
  />
</template>
