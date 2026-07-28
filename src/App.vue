<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import DebugDialogs from "@/components/DebugDialogs.vue";
import FaultDialog from "@/components/FaultDialog.vue";
import GameViewport from "@/components/GameViewport.vue";
import LogDialog from "@/components/LogDialog.vue";
import PreferencesDialog from "@/components/PreferencesDialog.vue";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const menu = ref<"file" | "debug" | null>(null);

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
    :style="{
      '--game-font': store.gameTextStyle.fontFamily,
      '--game-size': store.gameTextStyle.fontSize,
      '--game-background': store.presentation.settings.background
        ? `rgba(${store.presentation.settings.background.red}, ${store.presentation.settings.background.green}, ${store.presentation.settings.background.blue}, ${store.presentation.settings.background.alpha / 255})`
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
          <button @click="action(store.openProject)">打开项目…</button>
          <hr />
          <button :disabled="!store.projectOpen" @click="action(store.restart)">重新开始</button>
          <button :disabled="!store.projectOpen" @click="action(store.returnToTitle)">
            返回标题
          </button>
          <button :disabled="!store.projectOpen" @click="action(store.reloadProject)">
            重新加载全部脚本
          </button>
          <button :disabled="!store.projectOpen" @click="action(store.reloadProject)">
            重新加载文件夹…
          </button>
          <button :disabled="!store.projectOpen" @click="action(store.reloadProject)">
            重新加载单个脚本…
          </button>
          <hr />
          <button
            :disabled="!store.projectOpen"
            @click="action(() => store.exportSnapshot(store.debugEnabled ? 'debug' : 'normal'))"
          >
            导出 VM 快照…
          </button>
          <button :disabled="!store.projectOpen" @click="action(store.restoreSnapshot)">
            恢复 VM 快照…
          </button>
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
          <button @click="action(store.shutdown)">退出</button>
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
          <button @click="action(store.enableDebug)">
            {{ store.debugEnabled ? "禁用调试" : "启用调试" }}
          </button>
          <hr />
          <button
            :disabled="!store.debugEnabled"
            @click="
              action(() => {
                store.debugConsoleOpen = true;
              })
            "
          >
            控制台…
          </button>
          <button
            :disabled="!store.debugEnabled"
            @click="
              action(() => {
                store.variablesOpen = true;
              })
            "
          >
            变量查看器…
          </button>
          <button
            :disabled="!store.debugEnabled"
            @click="
              action(() => {
                store.stackOpen = true;
              })
            "
          >
            Fibers / 调用栈…
          </button>
          <button
            :disabled="!store.debugEnabled"
            @click="
              action(() => {
                store.singleStep = !store.singleStep;
              })
            "
          >
            {{ store.singleStep ? "关闭单步运行" : "开启单步运行" }}
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
      <span class="menu-spacer" />
      <span class="runtime-status" :title="store.status">{{ store.status }}</span>
      <span class="host-badge">{{ store.bridgeKind === "tauri" ? "Tauri" : "WASM" }}</span>
    </nav>

    <section v-if="!store.projectOpen" class="welcome">
      <h1>RustyEra</h1>
      <p>以同一套 Vue 界面运行于桌面和浏览器。</p>
      <button class="primary large" @click="store.openProject">打开 Era 项目…</button>
      <p v-if="store.bridgeKind === 'browser'" class="hint">
        浏览器完整模式需要桌面 Chromium、HTTPS/localhost，以及目录读写和本地字体权限。
      </p>
    </section>
    <template v-else>
      <GameViewport />
      <form class="prompt-bar" @submit.prevent="store.submitText">
        <span v-if="store.presentation.inputWait?.countdown_remaining_ms != null" class="countdown"
          >{{ Math.ceil(store.presentation.inputWait.countdown_remaining_ms / 1000) }}s</span
        >
        <input
          v-model="store.prompt"
          :disabled="!store.canInteract"
          :placeholder="store.canInteract ? '输入内容；Enter 提交' : '等待 Runtime…'"
          autofocus
        />
        <button
          type="button"
          :disabled="!store.inputUndo?.token"
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
    <LogDialog
      :open="store.logsOpen"
      :entries="store.logs"
      @close="store.logsOpen = false"
      @clear="store.logs.splice(0)"
    />
    <DebugDialogs />
    <FaultDialog />
  </div>
</template>
