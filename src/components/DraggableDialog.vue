<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  wide?: boolean;
  panelClass?: string;
  closeDisabled?: boolean;
  returnFocus?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const position = ref({ x: 0, y: 0 });
let drag: { pointerId: number; dx: number; dy: number } | undefined;
let previousFocus: Element | null = null;

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (open) {
      previousFocus = document.activeElement;
      await nextTick();
      center();
      panel.value?.focus();
    } else if (wasOpen) {
      await nextTick();
      restoreFocus();
    }
  },
);

function center(): void {
  const rect = panel.value?.getBoundingClientRect();
  if (!rect) return;
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  position.value = {
    x: left + Math.max(8, (width - rect.width) / 2),
    y: top + Math.max(8, (height - rect.height) / 3),
  };
}

function begin(event: PointerEvent): void {
  if (!panel.value) return;
  if (
    event.target instanceof Element &&
    event.target.closest("button, input, select, textarea, a, [data-no-drag]")
  ) {
    return;
  }
  drag = {
    pointerId: event.pointerId,
    dx: event.clientX - position.value.x,
    dy: event.clientY - position.value.y,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function move(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId) return;
  position.value = {
    x: event.clientX - drag.dx,
    y: event.clientY - drag.dy,
  };
}

function end(event: PointerEvent): void {
  if (drag?.pointerId === event.pointerId) drag = undefined;
}

function close(): void {
  if (props.closeDisabled) return;
  emit("close");
}

function restoreFocus(): void {
  const configuredTarget = props.returnFocus
    ? document.querySelector(props.returnFocus)
    : undefined;
  const target = configuredTarget ?? previousFocus;
  if (target instanceof HTMLElement && target.isConnected) target.focus();
  previousFocus = null;
}

function keydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
  if (event.key === "Tab" && panel.value) {
    const focusable = [
      ...panel.value.querySelectorAll<HTMLElement>(
        "button,input,select,textarea,[tabindex]:not([tabindex='-1'])",
      ),
    ].filter((item) => !item.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && first && last && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && first && last && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  event.stopPropagation();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" @pointerdown.self="close">
      <section
        ref="panel"
        class="dialog-panel"
        :class="[panelClass, { wide }]"
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
          <button
            type="button"
            class="icon-button"
            aria-label="关闭"
            :disabled="closeDisabled"
            data-no-drag
            @pointerdown.stop
            @click="close"
          >
            ×
          </button>
        </header>
        <div class="dialog-content" tabindex="0"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>
