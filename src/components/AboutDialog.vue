<script setup lang="ts">
import { computed } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import type { ProjectGameInformation } from "@/core/types";
import { platformFrontendVersion } from "@/platform";

const props = defineProps<{
  open: boolean;
  coreVersion: string;
  gameInformation?: ProjectGameInformation | null;
}>();
defineEmits<{ close: [] }>();
const frontendVersion = platformFrontendVersion();
const gameEntries = computed(() =>
  [
    ["游戏名称", props.gameInformation?.title],
    ["游戏作者", props.gameInformation?.author],
    ["游戏版本", props.gameInformation?.version],
    ["游戏开发时间", props.gameInformation?.year],
    ["备注", props.gameInformation?.information],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
);
</script>

<template>
  <DraggableDialog :open="open" title="关于 RustyEra" @close="$emit('close')">
    <dl class="about-details">
      <dt>作者</dt>
      <dd>PrunusSerrulata</dd>
      <dt>前端版本</dt>
      <dd>{{ frontendVersion }}</dd>
      <dt>core 版本</dt>
      <dd>{{ coreVersion }}</dd>
      <dt>许可证</dt>
      <dd>
        GPL-3.0-only
        <span class="license-scope"
          >仅适用于 RustyEra 相关组件；游戏本体的许可证以其指定的为准。</span
        >
      </dd>
      <dt>core 仓库</dt>
      <dd>
        <a href="https://github.com/PrunusSerrulata/rustyera-core" target="_blank" rel="noreferrer"
          >rustyera-core</a
        >
      </dd>
      <dt>Web 仓库</dt>
      <dd>
        <a href="https://github.com/PrunusSerrulata/rustyera-web" target="_blank" rel="noreferrer"
          >rustyera-web</a
        >
      </dd>
    </dl>
    <template v-if="gameEntries.length">
      <hr class="about-separator" />
      <h3 class="about-game-title">当前游戏</h3>
      <dl class="about-details game-details">
        <template v-for="[label, value] in gameEntries" :key="label">
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
    </template>
    <footer class="dialog-actions">
      <span class="spacer" />
      <button type="button" class="primary" @click="$emit('close')">确定</button>
    </footer>
  </DraggableDialog>
</template>
