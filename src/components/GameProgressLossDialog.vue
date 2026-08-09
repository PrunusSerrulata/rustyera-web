<script setup lang="ts">
import { computed } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";

type GameProgressLossAction = "restart" | "title";

const props = defineProps<{ action: GameProgressLossAction | null }>();
defineEmits<{ cancel: []; confirm: [] }>();

const content = computed(() =>
  props.action === "restart"
    ? {
        title: "重新开始游戏",
        warning: "重新开始游戏可能会丢失尚未保存的游戏进度。",
        confirmLabel: "重新开始",
      }
    : {
        title: "返回标题",
        warning: "返回标题可能会丢失尚未保存的游戏进度。",
        confirmLabel: "返回标题",
      },
);
</script>

<template>
  <DraggableDialog
    :open="action != null"
    :title="content.title"
    return-focus="#menu-file"
    @close="$emit('cancel')"
  >
    <p>{{ content.warning }}</p>
    <p>确定要继续吗？</p>
    <footer class="dialog-actions">
      <span class="spacer" />
      <button type="button" @click="$emit('cancel')">取消</button>
      <button type="button" class="danger" @click="$emit('confirm')">
        {{ content.confirmLabel }}
      </button>
    </footer>
  </DraggableDialog>
</template>
