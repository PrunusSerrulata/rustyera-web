<script setup lang="ts">
import { reactive, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { defaultPreferences, type Preferences } from "@/core/types";

const props = defineProps<{ open: boolean; value: Preferences; fonts: string[] }>();
const emit = defineEmits<{
  close: [];
  save: [value: Preferences];
  preview: [value: Preferences | null];
}>();
const draft = reactive<Preferences>({ ...props.value });

watch(
  () => props.open,
  (open) => {
    if (open) Object.assign(draft, props.value);
  },
);
watch(draft, () => props.open && emit("preview", { ...draft }), { deep: true });

function cancel(): void {
  emit("preview", null);
  emit("close");
}

function save(): void {
  emit("save", { ...draft });
  emit("close");
}

function reset(): void {
  Object.assign(draft, defaultPreferences());
}
</script>

<template>
  <DraggableDialog :open="open" title="偏好设置" @close="cancel">
    <form class="preferences-form" @submit.prevent="save">
      <label>
        <span>字体</span>
        <select v-model="draft.fontFamilyOverride">
          <option :value="null">跟随游戏设置</option>
          <option v-for="font in fonts" :key="font" :value="font">{{ font }}</option>
        </select>
      </label>
      <label>
        <span>字号</span>
        <div class="inline-field">
          <input
            v-model.number="draft.fontSizeOverridePx"
            type="number"
            min="8"
            max="72"
            step="1"
            placeholder="跟随游戏"
          />
          <span>px</span>
        </div>
      </label>
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
