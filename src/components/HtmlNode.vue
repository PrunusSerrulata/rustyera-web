<script setup lang="ts">
import { computed } from "vue";

import MediaImage from "@/components/MediaImage.vue";
import { useRuntimeStore } from "@/stores/runtime";

defineOptions({ name: "HtmlNode" });
const props = defineProps<{ node: any }>();
const store = useRuntimeStore();
const tags: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  paragraph: "p",
  no_break: "span",
  button: "button",
  non_button: "span",
  division: "div",
};
const tag = computed(() => tags[props.node.kind] ?? "span");
const imagePlacement = computed(() =>
  props.node.semantic?.type === "image"
    ? {
        resource_id: props.node.semantic.source,
        hover_resource_id: props.node.semantic.hover_source,
        mask_resource_id: props.node.semantic.mask_source,
        width: length(props.node.semantic.width),
        height: length(props.node.semantic.height),
        x: 0,
        y: length(props.node.semantic.y),
        depth: 0,
        opacity: { numerator: 1, denominator: 1 },
        revision: 0,
      }
    : null,
);

function activate(): void {
  const interaction = props.node.interaction;
  if (interaction?.enabled) void store.activate({ epoch: interaction.epoch, id: interaction.id });
}

function length(value: any): number {
  if (!value) return 0;
  return value.unit === "pixels" ? value.value * 1000 : value.value * 10;
}
</script>

<template>
  <template v-if="node.type === 'text'">{{ node.text }}</template>
  <br v-else-if="node.kind === 'break'" />
  <MediaImage v-else-if="imagePlacement" :placement="imagePlacement" />
  <component
    :is="tag"
    v-else
    :disabled="node.interaction && !node.interaction.enabled"
    class="html-node"
    @click="activate"
  >
    <HtmlNode v-for="(child, index) in node.children ?? []" :key="index" :node="child" />
  </component>
</template>
