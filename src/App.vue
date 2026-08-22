<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import AboutDialog from "@/components/AboutDialog.vue";
import BrowserFileSaveDialog from "@/components/BrowserFileSaveDialog.vue";
import AppMenuBar from "@/components/AppMenuBar.vue";
import CornerNotifications from "@/components/CornerNotifications.vue";
import DebugDialogs from "@/components/DebugDialogs.vue";
import FaultDialog from "@/components/FaultDialog.vue";
import FullProjectExportDialog from "@/components/FullProjectExportDialog.vue";
import GameProgressLossDialog from "@/components/GameProgressLossDialog.vue";
import GameViewport from "@/components/GameViewport.vue";
import InteractionAssistPanel from "@/components/InteractionAssistPanel.vue";
import LogDialog from "@/components/LogDialog.vue";
import OpenProjectDialog from "@/components/OpenProjectDialog.vue";
import ProjectSettingsDialog from "@/components/ProjectSettingsDialog.vue";
import ClientPreferencesDialog from "@/components/ClientPreferencesDialog.vue";
import ProjectReloadDialog from "@/components/ProjectReloadDialog.vue";
import TraditionalSaveDialog from "@/components/TraditionalSaveDialog.vue";
import { useMenuVisibility } from "@/components/useMenuVisibility";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const aboutOpen = ref(false);
const menuMode = computed(() => store.menuMode);
const {
  baseVisible: menuBaseVisible,
  temporarilyVisible: menuTemporarilyVisible,
  touchToggleVisible: menuTouchToggleVisible,
  toggleTouchMenu,
} = useMenuVisibility(menuMode);

function cssColor(color: any, fallback: string): string {
  return color
    ? `rgba(${color.red}, ${color.green}, ${color.blue}, ${Number(color.alpha) / 255})`
    : fallback;
}

onMounted(() => void store.initialize());
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'menu-overlay': !menuBaseVisible,
      'menu-overlay-open': menuTemporarilyVisible,
    }"
    :aria-busy="store.projectLoading || store.diagnosisExporting"
    :style="{
      '--game-font': store.gameTextStyle.fontFamily,
      '--game-size': store.gameTextStyle.fontSize,
      '--game-line-height': `${store.gameLineHeightPx}px`,
      '--game-background': cssColor(store.presentation.settings.background, '#101114'),
      '--game-focus': cssColor(store.presentation.settings.button_focus_foreground, '#ffff00'),
    }"
  >
    <div class="menu-row">
      <AppMenuBar @open-about="aboutOpen = true" />
      <button
        v-if="menuTouchToggleVisible"
        type="button"
        class="menu-touch-toggle"
        aria-controls="app-menu-bar"
        :aria-expanded="menuTemporarilyVisible"
        :aria-label="menuTemporarilyVisible ? '隐藏菜单栏' : '显示菜单栏'"
        @click="toggleTouchMenu"
      >
        <svg
          class="menu-touch-toggle-icon"
          :class="{ 'direction-down': !menuTemporarilyVisible }"
          viewBox="0 0 16 14"
          aria-hidden="true"
        >
          <path d="M3 7 8 2l5 5M3 12l5-5 5 5" />
        </svg>
      </button>
    </div>

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
      v-else-if="store.diagnosisExporting && !store.fault"
      class="project-load-progress diagnosis-export-progress"
      role="status"
      aria-live="polite"
      aria-label="诊断信息导出进度"
    >
      <progress aria-hidden="true" max="100" :value="store.diagnosisProgressValue ?? undefined" />
      <span>{{ store.diagnosisProgressLabel }}</span>
    </div>

    <CornerNotifications
      :notifications="store.logNotifications"
      @dismiss="store.dismissLogNotification"
    />

    <section v-if="!store.projectOpen" class="welcome">
      <h1>RustyEra</h1>
      <button class="primary large" :disabled="!store.canOpenProject" @click="store.openProject">
        打开 Era 项目…
      </button>
      <button class="large" :disabled="!store.canOpenProject" @click="store.openProjectFile">
        从项目文件启动…
      </button>
      <button id="welcome-preferences" class="large" @click="store.openPreferencesFromUser">
        偏好设置…
      </button>
      <p v-if="store.bridgeKind === 'browser' && !store.directProjectDirectoryAccess" class="hint">
        该浏览器不支持文件系统访问API，启动性能会受影响
      </p>
      <p v-if="store.bridgeKind === 'browser' && store.memoryConstrained" class="hint">
        低内存优化已启用，启动及快照恢复等会受影响
      </p>
    </section>
    <template v-else>
      <div class="game-area">
        <GameViewport />
        <InteractionAssistPanel />
      </div>
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

    <ProjectSettingsDialog
      :open="store.projectSettingsOpen"
      :font-families="store.availableFontFamilies"
      :font-access-status="store.fontAccessStatus"
      :font-access-error="store.fontAccessError"
      :host-kind="store.bridgeKind"
      :viewport-measurement="store.viewportMeasurement"
      :configuration-entries="store.configurationEntries"
      :project-source="store.projectSource"
      :configuration-read-only="store.configurationReadOnly"
      :configuration-session-only="store.configurationSessionOnly"
      :restart-pending="store.configurationRestartPending"
      :busy="store.settingsBusy"
      :error="store.projectSettingsError"
      @close="store.projectSettingsOpen = false"
      @request-fonts="store.requestSystemFonts"
      @save="store.saveProjectSettings"
    />
    <ClientPreferencesDialog
      :open="store.preferencesOpen"
      :global-value="store.preferences"
      :project-value="store.projectPreferences"
      :entries="store.configurationEntries"
      :font-families="store.availableFontFamilies"
      :font-access-status="store.fontAccessStatus"
      :font-access-error="store.fontAccessError"
      :host-kind="store.bridgeKind"
      :project-writable="store.projectPreferencesWritable"
      :busy="store.settingsBusy"
      :error="store.preferencesError"
      @close="store.preferencesOpen = false"
      @request-fonts="store.requestSystemFonts"
      @save="store.saveClientPreferences"
    />
    <OpenProjectDialog
      :open="store.openProjectConfirmationOpen"
      @cancel="store.cancelOpenProject"
      @confirm="store.confirmOpenProject"
    />
    <GameProgressLossDialog
      :action="store.gameProgressLossConfirmation"
      @cancel="store.cancelGameProgressLossAction"
      @confirm="store.confirmGameProgressLossAction"
    />
    <FullProjectExportDialog
      :open="store.projectFileExporting"
      :label="store.projectFileExportProgressLabel"
      :value="store.projectFileExportProgressValue"
      @cancel="store.cancelProjectFileExport"
    />
    <ProjectReloadDialog
      :mode="store.projectReloadDialogMode"
      :targets="store.projectReloadTargetOptions"
      :busy="store.projectReloadDialogBusy"
      :error="store.projectReloadDialogError"
      @close="store.closeProjectReloadDialog"
      @confirm="store.confirmProjectReload"
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
    <BrowserFileSaveDialog />
    <AboutDialog
      :open="aboutOpen"
      :core-version="store.coreVersion"
      :game-information="store.gameInformation"
      @close="aboutOpen = false"
    />
  </div>
</template>
