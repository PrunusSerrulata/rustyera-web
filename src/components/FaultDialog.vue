<script setup lang="ts">
import DraggableDialog from "@/components/DraggableDialog.vue";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
</script>

<template>
  <DraggableDialog :open="Boolean(store.fault)" title="游戏错误" wide @close="store.dismissFault">
    <p>游戏遇到了无法恢复的错误：</p>
    <pre class="fault-message">{{ store.faultMessage }}</pre>
    <p>诊断信息归档可发送给游戏项目或 RustyEra 开发者。</p>
    <footer class="dialog-actions">
      <button
        type="button"
        class="primary"
        :disabled="store.faultActionBusy || !store.canExportDiagnosis"
        @click="store.exportDiagnosis"
      >
        导出诊断信息…
      </button>
      <span class="spacer" />
      <button
        type="button"
        :disabled="store.faultActionBusy || store.gameInteractionsBlocked"
        @click="store.recoverFromFault('title')"
      >
        返回主菜单
      </button>
      <button
        type="button"
        :disabled="store.faultActionBusy || store.gameInteractionsBlocked"
        @click="store.recoverFromFault('reload')"
      >
        重启并重新编译
      </button>
      <button
        type="button"
        class="danger"
        :disabled="store.faultActionBusy || store.gameInteractionsBlocked"
        @click="store.shutdown"
      >
        {{ store.bridgeKind === "browser" ? "关闭当前标签页" : "退出" }}
      </button>
    </footer>
  </DraggableDialog>
</template>
