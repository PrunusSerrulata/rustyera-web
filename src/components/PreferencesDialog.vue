<script setup lang="ts">
import { reactive, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import {
  defaultPreferences,
  type Preferences,
  type ProjectConfigurationChange,
  type ProjectConfigurationEntry,
} from "@/core/types";

const props = withDefaults(
  defineProps<{
    open: boolean;
    value: Preferences;
    fonts: string[];
    configurationEntries?: ProjectConfigurationEntry[];
    configurationReadOnly?: boolean;
  }>(),
  { configurationEntries: () => [], configurationReadOnly: false },
);
const emit = defineEmits<{
  close: [];
  save: [value: Preferences, changes: ProjectConfigurationChange[]];
  preview: [value: Preferences | null];
}>();
const draft = reactive<Preferences>({ ...props.value });
const configurationDraft = reactive<Record<string, string>>({});

function resetConfigurationDraft(): void {
  for (const code of Object.keys(configurationDraft)) delete configurationDraft[code];
  for (const entry of props.configurationEntries) configurationDraft[entry.code] = entry.value;
}

function configurationCandidates(entry: ProjectConfigurationEntry): string[] {
  return entry.kind === "boolean" ? ["YES", "NO"] : entry.allowed;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      Object.assign(draft, props.value);
      resetConfigurationDraft();
    }
  },
);
watch(() => props.configurationEntries, resetConfigurationDraft, { deep: true });
watch(draft, () => props.open && emit("preview", preferenceDraft()), { deep: true });

function preferenceDraft(): Preferences {
  const fontSize = draft.fontSizeOverridePx as number | string | null;
  return {
    ...draft,
    fontSizeOverridePx: fontSize == null || fontSize === "" ? null : Number(fontSize),
  };
}

function cancel(): void {
  emit("preview", null);
  emit("close");
}

function save(): void {
  emit(
    "save",
    preferenceDraft(),
    props.configurationEntries
      .filter((entry) => !entry.fixed && configurationDraft[entry.code] !== entry.value)
      .map((entry) => ({ code: entry.code, value: String(configurationDraft[entry.code]) })),
  );
  emit("close");
}

function reset(): void {
  Object.assign(draft, defaultPreferences());
}
</script>

<template>
  <DraggableDialog :open="open" title="偏好设置" wide @close="cancel">
    <form class="preferences-form" @submit.prevent="save">
      <label>
        <span>游戏文本字体</span>
        <select v-model="draft.fontFamilyOverride">
          <option :value="null">跟随游戏设置</option>
          <option v-for="font in fonts" :key="font" :value="font">{{ font }}</option>
        </select>
      </label>
      <label>
        <span>游戏文本字号</span>
        <div class="inline-field">
          <input
            v-model.number="draft.fontSizeOverridePx"
            type="number"
            min="8"
            max="72"
            step="1"
            placeholder="跟随游戏设置"
          />
          <span>px</span>
        </div>
      </label>
      <fieldset v-if="configurationEntries.length" class="project-preferences">
        <legend>emuera.config</legend>
        <p class="hint">
          这里显示当前客户端支持的游戏设置。修改后会由 Runtime 校验并重新启动游戏。
        </p>
        <p v-if="configurationReadOnly" class="hint">
          当前从 .reraproj 项目文件运行，其中的 emuera.config 不能修改。
        </p>
        <label v-for="entry in configurationEntries" :key="entry.code">
          <span :title="entry.code">{{ entry.japanese || entry.english || entry.code }}</span>
          <select
            v-if="entry.kind === 'boolean' || entry.kind === 'enum'"
            v-model="configurationDraft[entry.code]"
            :disabled="configurationReadOnly || entry.fixed"
          >
            <option
              v-for="candidate in configurationCandidates(entry)"
              :key="candidate"
              :value="candidate"
            >
              {{ candidate }}
            </option>
          </select>
          <input
            v-else
            v-model="configurationDraft[entry.code]"
            :type="entry.kind === 'integer' ? 'number' : 'text'"
            :disabled="configurationReadOnly || entry.fixed"
          />
        </label>
      </fieldset>
      <label>
        <span>图片放大倍率</span>
        <div class="inline-field">
          <input v-model.number="draft.imageScale" type="range" min="0.25" max="4" step="0.05" />
          <output>{{ Math.round(draft.imageScale * 100) }}%</output>
        </div>
      </label>
      <label>
        <span>音量</span>
        <div class="inline-field">
          <input v-model.number="draft.masterVolume" type="range" min="0" max="1" step="0.01" />
          <output>{{ Math.round(draft.masterVolume * 100) }}%</output>
        </div>
      </label>
      <footer class="dialog-actions">
        <button type="button" @click="reset">恢复默认值</button>
        <span class="spacer" />
        <button type="button" @click="cancel">取消</button>
        <button type="submit" class="primary">保存</button>
      </footer>
    </form>
  </DraggableDialog>
</template>
