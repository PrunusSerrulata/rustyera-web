<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

const props = defineProps<{ open: boolean; value: string; title: string }>();
const emit = defineEmits<{ close: []; confirm: [value: string] }>();
const hex = ref("");
const rgb = reactive({ red: "", green: "", blue: "" });
const selection = reactive({ hue: 0, saturation: 0, brightness: 0 });
const error = ref("");
let activePointer: { target: "disk" | "brightness"; id: number } | undefined;

const current = computed(() => parseRgbParts(rgb.red, rgb.green, rgb.blue));
const preview = computed(() =>
  current.value
    ? `rgb(${current.value.red}, ${current.value.green}, ${current.value.blue})`
    : "transparent",
);
const diskStyle = computed(() => ({
  "--disk-shade": String(1 - selection.brightness),
  "--selector-x": `${50 + Math.cos((selection.hue * Math.PI) / 180) * selection.saturation * 50}%`,
  "--selector-y": `${50 + Math.sin((selection.hue * Math.PI) / 180) * selection.saturation * 50}%`,
}));
const brightnessStyle = computed(() => ({
  "--bright-color": rgbCss(hsvToRgb(selection.hue, selection.saturation, 1)),
  "--brightness-y": `${(1 - selection.brightness) * 100}%`,
}));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const initial = parseConfigColor(props.value) ?? { red: 0, green: 0, blue: 0 };
    setColor(initial);
  },
  { immediate: true },
);

function setColor(color: RgbColor, updateSelection = true): void {
  rgb.red = String(color.red);
  rgb.green = String(color.green);
  rgb.blue = String(color.blue);
  hex.value = `#${[color.red, color.green, color.blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
  if (updateSelection) Object.assign(selection, rgbToHsv(color));
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

function beginSelection(target: "disk" | "brightness", event: PointerEvent): void {
  activePointer = { target, id: event.pointerId };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  updateSelection(target, event);
}

function moveSelection(target: "disk" | "brightness", event: PointerEvent): void {
  if (activePointer?.target !== target || activePointer.id !== event.pointerId) return;
  updateSelection(target, event);
}

function endSelection(event: PointerEvent): void {
  if (activePointer?.id === event.pointerId) activePointer = undefined;
}

function keySelection(target: "disk" | "brightness", event: KeyboardEvent): void {
  if (!event.key.startsWith("Arrow")) return;
  event.preventDefault();
  if (target === "brightness") {
    selection.brightness = clamp01(
      selection.brightness + (event.key === "ArrowUp" || event.key === "ArrowRight" ? 0.02 : -0.02),
    );
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    selection.hue = (selection.hue + (event.key === "ArrowRight" ? 2 : 358)) % 360;
  } else {
    selection.saturation = clamp01(selection.saturation + (event.key === "ArrowUp" ? 0.02 : -0.02));
  }
  setColor(hsvToRgb(selection.hue, selection.saturation, selection.brightness), false);
}

function updateSelection(target: "disk" | "brightness", event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (target === "brightness") {
    selection.brightness = clamp01(1 - (event.clientY - rect.top) / rect.height);
  } else {
    const radius = Math.min(rect.width, rect.height) / 2;
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    selection.hue = (Math.atan2(y, x) * 180) / Math.PI;
    if (selection.hue < 0) selection.hue += 360;
    selection.saturation = clamp01(Math.hypot(x, y) / radius);
  }
  setColor(hsvToRgb(selection.hue, selection.saturation, selection.brightness), false);
}

function confirm(): void {
  const color = current.value;
  if (!color || error.value) return;
  emit("confirm", `${color.red},${color.green},${color.blue}`);
}

function rgbToHsv(color: RgbColor) {
  const red = color.red / 255;
  const green = color.green / 255;
  const blue = color.blue / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: max === 0 ? 0 : delta / max, brightness: max };
}

function hsvToRgb(hue: number, saturation: number, brightness: number): RgbColor {
  const chroma = brightness * saturation;
  const segment = hue / 60;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] =
    segment < 1
      ? [chroma, intermediate, 0]
      : segment < 2
        ? [intermediate, chroma, 0]
        : segment < 3
          ? [0, chroma, intermediate]
          : segment < 4
            ? [0, intermediate, chroma]
            : segment < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  const match = brightness - chroma;
  return {
    red: Math.round((red + match) * 255),
    green: Math.round((green + match) * 255),
    blue: Math.round((blue + match) * 255),
  };
}

function rgbCss(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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
      <div class="color-visual">
        <div
          class="color-disk"
          :style="diskStyle"
          role="application"
          aria-label="颜色圆盘"
          tabindex="0"
          @pointerdown="beginSelection('disk', $event)"
          @pointermove="moveSelection('disk', $event)"
          @pointerup="endSelection"
          @pointercancel="endSelection"
          @keydown="keySelection('disk', $event)"
        >
          <span class="color-disk-selector" />
        </div>
        <div
          class="color-brightness"
          :style="brightnessStyle"
          role="slider"
          aria-label="明暗调节"
          aria-valuemin="0"
          aria-valuemax="255"
          :aria-valuenow="Math.round(selection.brightness * 255)"
          tabindex="0"
          @pointerdown="beginSelection('brightness', $event)"
          @pointermove="moveSelection('brightness', $event)"
          @pointerup="endSelection"
          @pointercancel="endSelection"
          @keydown="keySelection('brightness', $event)"
        >
          <span class="color-brightness-selector" />
        </div>
        <div class="color-preview" :style="{ backgroundColor: preview }" aria-label="颜色预览" />
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
