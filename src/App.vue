<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import AboutDialog from "@/components/AboutDialog.vue";
import DebugDialogs from "@/components/DebugDialogs.vue";
import FaultDialog from "@/components/FaultDialog.vue";
import GameViewport from "@/components/GameViewport.vue";
import LogDialog from "@/components/LogDialog.vue";
import OpenProjectDialog from "@/components/OpenProjectDialog.vue";
import PreferencesDialog from "@/components/PreferencesDialog.vue";
import TraditionalSaveDialog from "@/components/TraditionalSaveDialog.vue";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const menu = ref<"file" | "debug" | "help" | null>(null);
const aboutOpen = ref(false);

function action(callback: () => void | Promise<void>): void {
  menu.value = null;
  void callback();
}

function documentClick(event: MouseEvent): void {
  if (!(event.target as Element).closest(".menu")) menu.value = null;
}

onMounted(() => {
  void store.initialize();
  document.addEventListener("pointerdown", documentClick);
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", documentClick));
</script>

<template>
  <div
    class="app-shell"
    :aria-busy="store.projectLoading"
    :style="{
      '--game-font': store.gameTextStyle.fontFamily,
      '--game-size': store.gameTextStyle.fontSize,
      '--game-background': store.presentation.settings.background
        ? `rgba(${store.presentation.settings.background.red}, ${store.presentation.settings.background.green}, ${store.presentation.settings.background.blue}, ${Number(store.presentation.settings.background.alpha) / 255})`
        : '#101114',
    }"
  >
    <nav class="menu-bar" aria-label="应用菜单">
      <div class="menu">
        <button
          :aria-expanded="menu === 'file'"
          @click.stop="menu = menu === 'file' ? null : 'file'"
        >
          文件
        </button>
        <div v-if="menu === 'file'" class="menu-popup">
          <button :disabled="!store.canOpenProject" @click="action(store.openProject)">
            打开项目…
          </button>
          <hr />
          <button
            :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
            @click="action(store.restart)"
          >
            重新开始
          </button>
          <button
            :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
            @click="action(store.returnToTitle)"
          >
            返回标题
          </button>
          <button
            :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
            @click="action(store.reloadProject)"
          >
            重新加载全部脚本
          </button>
          <button
            :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
            @click="action(store.reloadProject)"
          >
            重新加载文件夹…
          </button>
          <button
            :disabled="!store.runtimeReady || store.gameInteractionsBlocked"
            @click="action(store.reloadProject)"
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
            @click="
              action(() => {
                store.preferencesOpen = true;
              })
            "
          >
            偏好设置…
          </button>
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
        <button
          :aria-expanded="menu === 'help'"
          @click.stop="menu = menu === 'help' ? null : 'help'"
        >
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
                aboutOpen = true;
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

    <div
      v-if="store.projectLoading"
      class="project-load-progress"
      role="status"
      aria-live="polite"
      aria-label="项目加载进度"
    >
      <progress aria-hidden="true" max="100" :value="store.projectLoadProgressValue ?? undefined" />
      <span>{{ store.projectLoadProgressLabel }}</span>
    </div>

    <div
      v-if="store.diagnosisNotification"
      class="diagnosis-notification"
      role="status"
      aria-live="polite"
    >
      {{ store.diagnosisNotification }}
    </div>

    <section v-if="!store.projectOpen" class="welcome">
      <h1>RustyEra</h1>
      <p>以同一套 Vue 界面运行于桌面和浏览器。</p>
      <button class="primary large" :disabled="!store.canOpenProject" @click="store.openProject">
        打开 Era 项目…
      </button>
      <p v-if="store.bridgeKind === 'browser'" class="hint">
        Chromium 可直接读写项目目录；Firefox 和 Safari 会将所选项目导入浏览器存储。
      </p>
    </section>
    <template v-else>
      <GameViewport />
      <form class="prompt-bar" @submit.prevent="store.submitText">
        <span v-if="store.presentation.inputWait?.countdown_remaining_ms != null" class="countdown"
          >{{
            Math.ceil(Number(store.presentation.inputWait.countdown_remaining_ms) / 1000)
          }}s</span
        >
        <input
          v-model="store.prompt"
          :disabled="!store.canInteract"
          :placeholder="store.promptPlaceholder"
          autofocus
        />
        <button
          type="button"
          :disabled="!store.inputUndo?.token || store.gameInteractionsBlocked"
          title="撤销上次输入 (Ctrl+Z)"
          @click="store.undo"
        >
          撤销
        </button>
        <button type="submit" :disabled="!store.canInteract">提交</button>
      </form>
    </template>

    <PreferencesDialog
      :open="store.preferencesOpen"
      :value="store.preferences"
      :fonts="store.fonts"
      @close="store.preferencesOpen = false"
      @preview="store.preview"
      @save="store.savePreferences"
    />
    <OpenProjectDialog
      :open="store.openProjectConfirmationOpen"
      @cancel="store.cancelOpenProject"
      @confirm="store.confirmOpenProject"
    />
    <TraditionalSaveDialog
      :open="store.traditionalSaveDialogMode != null"
      :mode="store.traditionalSaveDialogMode"
      :slots="store.traditionalSaveSlots"
      :import-name="store.traditionalSaveImportName"
      :busy="store.traditionalSaveTransferBusy"
      :error="store.traditionalSaveTransferError"
      :overwrite-slot="store.traditionalSaveOverwriteSlot"
      @close="store.closeTraditionalSaveDialog"
      @pick="store.pickTraditionalSaveImport"
      @confirm="store.confirmTraditionalSaveTransfer"
      @cancel-overwrite="store.cancelTraditionalSaveOverwrite"
      @confirm-overwrite="store.confirmTraditionalSaveOverwrite"
    />
    <LogDialog
      :open="store.logsOpen"
      :entries="store.logs"
      @close="store.logsOpen = false"
      @clear="store.logs.splice(0)"
    />
    <DebugDialogs />
    <FaultDialog />
    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
  </div>
</template>
