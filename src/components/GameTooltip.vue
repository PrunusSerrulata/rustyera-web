<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type { Color, TooltipFormatFlag, TooltipSettings } from "@/core/types";

const props = defineProps<{
  scope?: HTMLElement;
  settings: TooltipSettings;
}>();

const tooltip = ref<HTMLElement>();
const text = ref("");
const visible = ref(false);
const left = ref(0);
const top = ref(0);
let activeTarget: HTMLElement | undefined;
let pointerX = 0;
let pointerY = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let placementVersion = 0;

const flags = computed(
  () => new Set<TooltipFormatFlag>(props.settings.normalized_format?.flags ?? []),
);
const style = computed(() => ({
  left: `${left.value}px`,
  top: `${top.value}px`,
  color: rgba(props.settings.foreground),
  backgroundColor: rgba(props.settings.background),
  fontFamily: props.settings.font_family || "inherit",
  fontSize: `${Number(props.settings.font_millipoints || 9_000) / 1_000}pt`,
  textAlign: flags.value.has("right")
    ? ("right" as const)
    : flags.value.has("horizontal_center")
      ? ("center" as const)
      : ("left" as const),
  direction: flags.value.has("right_to_left") ? ("rtl" as const) : ("ltr" as const),
  whiteSpace: flags.value.has("single_line") ? ("nowrap" as const) : ("pre-wrap" as const),
  overflowWrap: flags.value.has("word_break") ? ("anywhere" as const) : ("normal" as const),
  padding: flags.value.has("no_padding") ? "0" : undefined,
}));

function rgba(color: Color | undefined): string | undefined {
  if (!color) return undefined;
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`;
}

function tooltipTarget(value: EventTarget | null): HTMLElement | undefined {
  if (!(value instanceof Element) || !props.scope) return undefined;
  const target = value.closest<HTMLElement>("[data-era-tooltip]");
  return target && props.scope.contains(target) ? target : undefined;
}

function normalizedText(target: HTMLElement): string {
  return (target.dataset.eraTooltip ?? "").replaceAll("<br>", "\n");
}

function activate(target: HTMLElement, x: number, y: number): void {
  const nextText = normalizedText(target);
  if (!nextText) {
    dismiss();
    return;
  }
  pointerX = x;
  pointerY = y;
  if (activeTarget === target) {
    if (visible.value) void place();
    return;
  }
  dismiss();
  activeTarget = target;
  text.value = nextText;
  const delay = Math.max(0, Number(props.settings.delay_ms) || 0);
  if (delay === 0) show();
  else showTimer = setTimeout(show, delay);
}

function show(): void {
  showTimer = undefined;
  if (!activeTarget) return;
  left.value = pointerX + 2;
  top.value = pointerY + 18;
  visible.value = true;
  void place();
  const duration = Math.max(0, Number(props.settings.duration_ms) || 0);
  if (duration > 0) hideTimer = setTimeout(dismiss, duration);
}

async function place(): Promise<void> {
  const version = ++placementVersion;
  await nextTick();
  if (!visible.value || version !== placementVersion || !tooltip.value) return;
  const margin = 8;
  const cursorHeight = 18;
  const width = tooltip.value.offsetWidth;
  const height = tooltip.value.offsetHeight;
  left.value = Math.max(margin, Math.min(pointerX + 2, window.innerWidth - width - margin));
  const below = pointerY + cursorHeight;
  top.value =
    below + height <= window.innerHeight - margin
      ? below
      : Math.max(margin, pointerY - height - margin);
}

function dismiss(): void {
  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);
  showTimer = undefined;
  hideTimer = undefined;
  activeTarget = undefined;
  visible.value = false;
  placementVersion += 1;
}

function mouseOver(event: MouseEvent): void {
  const target = tooltipTarget(event.target);
  if (target) activate(target, event.clientX, event.clientY);
}

function mouseMove(event: MouseEvent): void {
  const target = tooltipTarget(event.target);
  if (!target) return;
  if (target !== activeTarget) {
    activate(target, event.clientX, event.clientY);
    return;
  }
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (visible.value) void place();
}

function mouseOut(event: MouseEvent): void {
  if (tooltipTarget(event.relatedTarget) === activeTarget) return;
  dismiss();
}

function focusIn(event: FocusEvent): void {
  const target = tooltipTarget(event.target);
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  activate(target, bounds.left + bounds.width / 2, bounds.bottom);
}

function focusOut(event: FocusEvent): void {
  if (tooltipTarget(event.relatedTarget) === activeTarget) return;
  dismiss();
}

function attach(scope: HTMLElement | undefined): void {
  scope?.addEventListener("mouseover", mouseOver);
  scope?.addEventListener("mousemove", mouseMove);
  scope?.addEventListener("mouseout", mouseOut);
  scope?.addEventListener("focusin", focusIn);
  scope?.addEventListener("focusout", focusOut);
  scope?.addEventListener("scroll", dismiss);
  scope?.addEventListener("click", dismiss);
}

function detach(scope: HTMLElement | undefined): void {
  scope?.removeEventListener("mouseover", mouseOver);
  scope?.removeEventListener("mousemove", mouseMove);
  scope?.removeEventListener("mouseout", mouseOut);
  scope?.removeEventListener("focusin", focusIn);
  scope?.removeEventListener("focusout", focusOut);
  scope?.removeEventListener("scroll", dismiss);
  scope?.removeEventListener("click", dismiss);
}

watch(
  () => props.scope,
  (scope, previous) => {
    detach(previous);
    dismiss();
    attach(scope);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  detach(props.scope);
  dismiss();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      id="game-tooltip"
      ref="tooltip"
      class="game-tooltip"
      role="tooltip"
      :style="style"
    >
      {{ text }}
    </div>
  </Teleport>
</template>
