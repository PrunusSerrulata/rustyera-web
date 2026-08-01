<script setup lang="ts">
import { onMounted, ref } from "vue";

import AboutDialog from "@/components/AboutDialog.vue";
import AppMenuBar from "@/components/AppMenuBar.vue";
import DebugDialogs from "@/components/DebugDialogs.vue";
import FaultDialog from "@/components/FaultDialog.vue";
import GameViewport from "@/components/GameViewport.vue";
import LogDialog from "@/components/LogDialog.vue";
import OpenProjectDialog from "@/components/OpenProjectDialog.vue";
import PreferencesDialog from "@/components/PreferencesDialog.vue";
import TraditionalSaveDialog from "@/components/TraditionalSaveDialog.vue";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const aboutOpen = ref(false);

onMounted(() => void store.initialize());
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
    <AppMenuBar @open-about="aboutOpen = true" />

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
      <button class="large" :disabled="!store.canOpenProject" @click="store.openProjectFile">
        从项目文件启动…
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
