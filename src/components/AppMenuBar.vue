<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import { useRuntimeStore } from "@/stores/runtime";

const emit = defineEmits<{ openAbout: [] }>();
const store = useRuntimeStore();
const menu = ref<"file" | "debug" | "help" | null>(null);

function action(callback: () => void | Promise<void>): void {
  menu.value = null;
  void callback();
}

function documentClick(event: PointerEvent): void {
  if (!(event.target as Element).closest(".menu")) menu.value = null;
}

onMounted(() => document.addEventListener("pointerdown", documentClick));
onBeforeUnmount(() => document.removeEventListener("pointerdown", documentClick));
</script>

<template>
  <nav id="app-menu-bar" class="menu-bar" aria-label="应用菜单">
    <div class="menu">
      <button
        id="menu-file"
        :aria-expanded="menu === 'file'"
        @click.stop="menu = menu === 'file' ? null : 'file'"
      >
        文件
      </button>
      <div v-if="menu === 'file'" class="menu-popup">
        <button :disabled="!store.canOpenProject" @click="action(store.openProject)">
          打开项目…
        </button>
        <button :disabled="!store.canOpenProject" @click="action(store.openProjectFile)">
          从项目文件启动…
        </button>
        <hr />
        <button
          :disabled="!store.canExportProjectFile"
          :title="
            store.runtimeReady && !store.fullProjectExportSupported
              ? '浏览器从项目文件启动时暂不支持导出全量项目文件'
              : undefined
          "
          @click="action(store.exportProjectFile)"
        >
          导出全量项目文件…
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(store.requestRestart)"
        >
          重新开始
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(store.requestReturnToTitle)"
        >
          返回标题
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(() => store.reloadProject())"
        >
          重新加载全部脚本
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(() => store.openProjectReloadDialog('folder'))"
        >
          重新加载文件夹…
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(() => store.openProjectReloadDialog('script'))"
        >
          重新加载单个脚本…
        </button>
        <hr />
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(() => store.exportSnapshot(store.debugEnabled ? 'debug' : 'normal'))"
        >
          导出 VM 快照…
        </button>
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(store.restoreSnapshot)"
        >
          恢复 VM 快照…
        </button>
        <template v-if="store.bridgeKind === 'browser'">
          <hr />
          <button
            :disabled="!store.canManageTraditionalSaves"
            @click="action(() => store.openTraditionalSaveDialog('export'))"
          >
            导出存档…
          </button>
          <button
            :disabled="!store.canManageTraditionalSaves"
            @click="action(() => store.openTraditionalSaveDialog('import'))"
          >
            导入存档…
          </button>
        </template>
        <hr />
        <button
          :disabled="store.configurationEntries.length === 0"
          @click="action(store.openProjectSettingsFromUser)"
        >
          项目设置…
        </button>
        <button @click="action(store.openPreferencesFromUser)">偏好设置…</button>
        <hr />
        <button :disabled="store.gameInteractionsBlocked" @click="action(store.shutdown)">
          {{ store.bridgeKind === "browser" ? "关闭当前标签页" : "退出" }}
        </button>
      </div>
    </div>
    <div class="menu">
      <button
        :aria-expanded="menu === 'debug'"
        @click.stop="menu = menu === 'debug' ? null : 'debug'"
      >
        调试
      </button>
      <div v-if="menu === 'debug'" class="menu-popup">
        <button
          :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
          @click="action(store.enableDebug)"
        >
          {{ store.debugEnabled ? "禁用调试" : "启用调试" }}
        </button>
        <hr />
        <button
          :disabled="!store.runtimeReady || !store.debugEnabled || store.gameInteractionsBlocked"
          @click="action(() => store.openDebugDialog('console'))"
        >
          控制台…
        </button>
        <button
          :disabled="!store.runtimeReady || !store.debugEnabled || store.gameInteractionsBlocked"
          @click="action(() => store.openDebugDialog('variables'))"
        >
          变量查看器…
        </button>
        <button
          :disabled="!store.runtimeReady || !store.debugEnabled || store.gameInteractionsBlocked"
          @click="action(() => store.openDebugDialog('stack'))"
        >
          Fibers / 调用栈…
        </button>
        <button
          :disabled="!store.runtimeReady || !store.debugEnabled || store.gameInteractionsBlocked"
          @click="action(store.toggleSingleStep)"
        >
          {{ store.singleStepEnabled ? "关闭单步运行" : "开启单步运行" }}
        </button>
        <button
          :disabled="!store.runtimeReady || !store.canStepDebug"
          @click="action(store.stepDebug)"
        >
          单步执行 (F10)
        </button>
        <hr />
        <button
          @click="
            action(() => {
              store.logsOpen = true;
            })
          "
        >
          日志…
        </button>
      </div>
    </div>
    <div class="menu">
      <button :aria-expanded="menu === 'help'" @click.stop="menu = menu === 'help' ? null : 'help'">
        帮助
      </button>
      <div v-if="menu === 'help'" class="menu-popup">
        <button :disabled="!store.canExportDiagnosis" @click="action(store.exportDiagnosis)">
          导出诊断信息…
        </button>
        <hr />
        <button
          @click="
            action(() => {
              emit('openAbout');
            })
          "
        >
          关于…
        </button>
      </div>
    </div>
    <span class="menu-spacer" />
    <span class="runtime-status" :title="store.status">{{ store.status }}</span>
    <span class="host-badge">{{ store.bridgeKind === "tauri" ? "Tauri" : "WASM" }}</span>
  </nav>
</template>
