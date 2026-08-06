<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";

const props = defineProps<{ open: boolean; value: string; title: string }>();
const emit = defineEmits<{ close: []; confirm: [value: string] }>();
const hex = ref("");
const rgb = reactive({ red: "", green: "", blue: "" });
const error = ref("");
const levels = [0, 51, 102, 153, 204, 255];
const palette = levels.flatMap((red) =>
  levels.flatMap((green) => levels.map((blue) => ({ red, green, blue }))),
);

const current = computed(() => parseRgbParts(rgb.red, rgb.green, rgb.blue));
const preview = computed(() =>
  current.value
    ? `rgb(${current.value.red}, ${current.value.green}, ${current.value.blue})`
    : "transparent",
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const initial = parseConfigColor(props.value) ?? { red: 0, green: 0, blue: 0 };
    setColor(initial);
  },
  { immediate: true },
);

function setColor(color: { red: number; green: number; blue: number }): void {
  rgb.red = String(color.red);
  rgb.green = String(color.green);
  rgb.blue = String(color.blue);
  hex.value = `#${[color.red, color.green, color.blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
  error.value = "";
}

function updateHex(value: string): void {
  hex.value = value;
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    error.value = "请输入 #RRGGBB 格式的颜色值";
    return;
  }
  setColor({
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  });
}

function updateRgb(channel: keyof typeof rgb, value: string): void {
  rgb[channel] = value;
  const parsed = current.value;
  if (!parsed) {
    error.value = "RGB 分量必须是 0 到 255 的整数";
    return;
  }
  setColor(parsed);
}

function confirm(): void {
  const color = current.value;
  if (!color || error.value) return;
  emit("confirm", `${color.red},${color.green},${color.blue}`);
}

function parseRgbParts(red: string, green: string, blue: string) {
  const values = [red, green, blue].map((value) =>
    /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN,
  );
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    return undefined;
  return { red: values[0]!, green: values[1]!, blue: values[2]! };
}

function parseConfigColor(value: string) {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 3) return undefined;
  return parseRgbParts(parts[0]!, parts[1]!, parts[2]!);
}
</script>

<template>
  <DraggableDialog :open="open" :title="title" @close="emit('close')">
    <form class="color-picker" @submit.prevent="confirm">
      <div class="color-preview" :style="{ backgroundColor: preview }" aria-label="颜色预览" />
      <div class="color-palette" role="group" aria-label="色板">
        <button
          v-for="color in palette"
          :key="`${color.red}-${color.green}-${color.blue}`"
          type="button"
          class="palette-swatch"
          :class="{
            selected:
              current &&
              current.red === color.red &&
              current.green === color.green &&
              current.blue === color.blue,
          }"
          :style="{ backgroundColor: `rgb(${color.red}, ${color.green}, ${color.blue})` }"
          :aria-label="`RGB ${color.red}, ${color.green}, ${color.blue}`"
          @click="setColor(color)"
        />
      </div>
      <label class="color-hex">
        <span>HEX</span>
        <input
          :value="hex"
          autocomplete="off"
          @input="updateHex(($event.target as HTMLInputElement).value)"
        />
      </label>
      <div class="rgb-fields">
        <label v-for="channel in ['red', 'green', 'blue'] as const" :key="channel">
          <span>{{ channel === "red" ? "R" : channel === "green" ? "G" : "B" }}</span>
          <input
            type="number"
            min="0"
            max="255"
            step="1"
            :value="rgb[channel]"
            @input="updateRgb(channel, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <button type="button" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="Boolean(error) || !current">确定</button>
      </footer>
    </form>
  </DraggableDialog>
</template>
