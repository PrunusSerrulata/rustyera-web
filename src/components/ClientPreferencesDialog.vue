<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { projectSettingsTabs, type SettingsField } from "@/core/settings";
import type { Preferences, ProjectConfigurationEntry, ProjectPreferences } from "@/core/types";

const props = withDefaults(
  defineProps<{
    open: boolean;
    globalValue: Preferences;
    projectValue: ProjectPreferences;
    entries: ProjectConfigurationEntry[];
    projectWritable?: boolean;
    busy?: boolean;
    error?: string;
  }>(),
  { projectWritable: false, busy: false, error: "" },
);
const emit = defineEmits<{
  close: [];
  save: [scope: "global" | "project", value: ProjectPreferences];
}>();

const scope = ref<"global" | "project">("global");
const draft = reactive<ProjectPreferences>({ settings: {} });
const eligibleEntries = computed(() => props.entries.filter((entry) => entry.preference_eligible));
const entryMap = computed(() => new Map(eligibleEntries.value.map((entry) => [entry.code, entry])));
const fields = computed(() => {
  const allowed = entryMap.value;
  return projectSettingsTabs
    .flatMap((tab) => tab.groups.flatMap((group) => group.fields))
    .filter((field) => allowed.has(field.code));
});

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
  return Object.hasOwn(draft.settings, code);
}

function toggle(field: SettingsField, enabled: boolean): void {
  if (enabled) {
    const entry = entryMap.value.get(field.code);
    draft.settings[field.code] = entry?.client_effective_value ?? entry?.effective_value ?? "";
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

function auxiliaryOverridden(key: "imageScale" | "masterVolume" | "trustProjectFileMetadata") {
  return scope.value === "global" || draft[key] != null;
}

function toggleAuxiliary(
  key: "imageScale" | "masterVolume" | "trustProjectFileMetadata",
  enabled: boolean,
): void {
  if (key === "imageScale") {
    draft.imageScale = !enabled && scope.value === "project" ? undefined : 1;
  } else if (key === "masterVolume") {
    draft.masterVolume = !enabled && scope.value === "project" ? undefined : 1;
  } else {
    draft.trustProjectFileMetadata = !enabled && scope.value === "project" ? undefined : false;
  }
}

function save(): void {
  emit("save", scope.value, {
    settings: { ...draft.settings },
    imageScale: draft.imageScale,
    masterVolume: draft.masterVolume,
    trustProjectFileMetadata: draft.trustProjectFileMetadata,
  });
}
</script>

<template>
  <DraggableDialog
    :open="open"
    title="RustyEra · 偏好设置"
    panel-class="settings-panel"
    :close-disabled="busy"
    @close="emit('close')"
  >
    <form class="settings-dialog" @submit.prevent="save">
      <div class="settings-tabs" role="tablist" aria-label="偏好作用域">
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'global'"
          @click="scope = 'global'"
        >
          全局偏好
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'project'"
          :disabled="!projectWritable"
          @click="scope = 'project'"
        >
          项目偏好
        </button>
      </div>

      <div class="settings-scroll">
        <p class="settings-warning" role="note">
          项目偏好优先于项目设置，全局偏好仅在项目没有明确设置时生效。偏好只影响当前客户端显示与交互，不改变游戏逻辑。
        </p>
        <fieldset class="settings-group">
          <legend>项目设置覆盖</legend>
          <div class="settings-grid">
            <div v-for="field in fields" :key="field.code" class="setting-item setting-wide">
              <label>
                <input
                  :id="`preference-${scope}-${field.code}-override`"
                  type="checkbox"
                  :checked="overridden(field.code)"
                  :disabled="busy"
                  @change="toggle(field, ($event.target as HTMLInputElement).checked)"
                />
                覆盖 {{ field.label }}
              </label>
              <div class="setting-control">
                <input
                  v-if="field.control === 'boolean'"
                  :id="`preference-${scope}-${field.code}`"
                  type="checkbox"
                  :checked="booleanValue(field.code)"
                  :disabled="busy || !overridden(field.code)"
                  @change="setBoolean(field.code, ($event.target as HTMLInputElement).checked)"
                />
                <select
                  v-else-if="field.control === 'enum'"
                  :id="`preference-${scope}-${field.code}`"
                  v-model="draft.settings[field.code]"
                  :disabled="busy || !overridden(field.code)"
                >
                  <option
                    v-for="value in entryMap.get(field.code)?.allowed ?? []"
                    :key="value"
                    :value="value"
                  >
                    {{ value }}
                  </option>
                </select>
                <input
                  v-else
                  :id="`preference-${scope}-${field.code}`"
                  :value="draft.settings[field.code]"
                  :type="
                    field.control === 'number' || field.control === 'range' ? 'number' : 'text'
                  "
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
            <div class="setting-item">
              <label>
                <input
                  v-if="scope === 'project'"
                  type="checkbox"
                  :checked="auxiliaryOverridden('imageScale')"
                  :disabled="busy"
                  @change="
                    toggleAuxiliary('imageScale', ($event.target as HTMLInputElement).checked)
                  "
                />
                图片缩放
              </label>
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
            <div class="setting-item">
              <label>
                <input
                  v-if="scope === 'project'"
                  type="checkbox"
                  :checked="auxiliaryOverridden('masterVolume')"
                  :disabled="busy"
                  @change="
                    toggleAuxiliary('masterVolume', ($event.target as HTMLInputElement).checked)
                  "
                />
                主音量
              </label>
              <input
                :id="`preference-${scope}-masterVolume`"
                v-model.number="draft.masterVolume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :disabled="busy || !auxiliaryOverridden('masterVolume')"
              />
            </div>
            <label class="setting-item boolean-setting">
              <input
                v-if="scope === 'project'"
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
              <span>覆盖快速启动文件元数据策略</span>
              <input
                :id="`preference-${scope}-trustProjectFileMetadata`"
                v-model="draft.trustProjectFileMetadata"
                type="checkbox"
                :disabled="busy || !auxiliaryOverridden('trustProjectFileMetadata')"
              />
            </label>
          </div>
        </fieldset>
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions settings-actions">
        <button type="button" :disabled="busy" @click="resetDraft">重置未保存更改</button>
        <span class="spacer" />
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="busy">应用</button>
      </footer>
    </form>
  </DraggableDialog>
</template>
