<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps<{ open: boolean; title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const position = ref({ x: 0, y: 0 });
let drag: { pointerId: number; dx: number; dy: number } | undefined;
let previousFocus: Element | null = null;

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    previousFocus = document.activeElement;
    await nextTick();
    center();
    panel.value?.focus();
  },
);

function center(): void {
  const rect = panel.value?.getBoundingClientRect();
  if (!rect) return;
  position.value = {
    x: Math.max(8, (window.innerWidth - rect.width) / 2),
    y: Math.max(8, (window.innerHeight - rect.height) / 3),
  };
}

function begin(event: PointerEvent): void {
  if (!panel.value) return;
  drag = {
    pointerId: event.pointerId,
    dx: event.clientX - position.value.x,
    dy: event.clientY - position.value.y,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function move(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId || !panel.value) return;
  const rect = panel.value.getBoundingClientRect();
  position.value = {
    x: Math.min(Math.max(0, event.clientX - drag.dx), Math.max(0, window.innerWidth - rect.width)),
    y: Math.min(
      Math.max(0, event.clientY - drag.dy),
      Math.max(0, window.innerHeight - rect.height),
    ),
  };
}

function end(event: PointerEvent): void {
  if (drag?.pointerId === event.pointerId) drag = undefined;
}

function close(): void {
  emit("close");
  if (previousFocus instanceof HTMLElement) previousFocus.focus();
}

function keydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
  if (event.key !== "Tab" || !panel.value) return;
  const focusable = [
    ...panel.value.querySelectorAll<HTMLElement>(
      "button,input,select,textarea,[tabindex]:not([tabindex='-1'])",
    ),
  ].filter((item) => !item.hasAttribute("disabled"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function clamp(): void {
  if (!panel.value) return;
  const rect = panel.value.getBoundingClientRect();
  position.value = {
    x: Math.min(position.value.x, Math.max(0, innerWidth - rect.width)),
    y: Math.min(position.value.y, Math.max(0, innerHeight - rect.height)),
  };
}

onMounted(() => window.addEventListener("resize", clamp));
onUnmounted(() => window.removeEventListener("resize", clamp));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" @pointerdown.self="close">
      <section
        ref="panel"
        class="dialog-panel"
        :class="{ wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        :style="{ left: `${position.x}px`, top: `${position.y}px` }"
        @keydown="keydown"
      >
        <header
          class="dialog-title"
          @pointerdown="begin"
          @pointermove="move"
          @pointerup="end"
          @pointercancel="end"
        >
          <span>{{ title }}</span>
          <button type="button" class="icon-button" aria-label="关闭" @click="close">×</button>
        </header>
        <div class="dialog-content"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>
