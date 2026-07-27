<script setup lang="ts">
import DraggableDialog from "@/components/DraggableDialog.vue";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
</script>

<template>
  <DraggableDialog :open="Boolean(store.fault)" title="游戏错误" wide @close="store.fault = null">
    <p>游戏遇到了无法恢复的错误：</p>
    <pre class="fault-message">{{ store.fault?.message ?? store.fault }}</pre>
    <p>诊断快照可连同日志发送给游戏项目或 RustyEra 开发者。</p>
    <footer class="dialog-actions">
      <button class="primary" @click="store.exportSnapshot('diagnosis')">导出诊断快照…</button>
      <span class="spacer" />
      <button
        @click="
          store.returnToTitle();
          store.fault = null;
        "
      >
        返回主菜单
      </button>
      <button
        @click="
          store.reloadProject();
          store.fault = null;
        "
      >
        重启并重新编译
      </button>
      <button class="danger" @click="store.shutdown">退出</button>
    </footer>
  </DraggableDialog>
</template>
