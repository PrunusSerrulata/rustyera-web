<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { BROWSER_FILE_SAVE_EVENT, type BrowserFileSaveRequest } from "@/platform/browserDownload";

const pending = ref<File[]>([]);
const busy = ref(false);
const error = ref("");

function receive(event: Event): void {
  const request = (event as CustomEvent<BrowserFileSaveRequest>).detail;
  if (!(request?.file instanceof File)) return;
  pending.value.push(request.file);
}

function close(): void {
  if (busy.value) return;
  pending.value.shift();
  error.value = "";
}

async function save(): Promise<void> {
  const file = pending.value[0];
  if (!file) return;
  busy.value = true;
  error.value = "";
  try {
    await navigator.share({ files: [file], title: file.name });
    pending.value.shift();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => window.addEventListener(BROWSER_FILE_SAVE_EVENT, receive));
onBeforeUnmount(() => window.removeEventListener(BROWSER_FILE_SAVE_EVENT, receive));
</script>

<template>
  <DraggableDialog
    :open="pending.length > 0"
    title="保存导出文件"
    :close-disabled="busy"
    @close="close"
  >
    <p>Firefox iOS 无法为网页生成的下载保留文件名。请通过系统分享菜单存储此文件。</p>
    <p v-if="pending[0]"><strong>文件名：</strong>{{ pending[0].name }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <footer class="dialog-actions">
      <button type="button" :disabled="busy" @click="close">取消</button>
      <span class="spacer" />
      <button type="button" class="primary" :disabled="busy" @click="save">
        {{ busy ? "正在打开…" : "打开系统分享菜单" }}
      </button>
    </footer>
  </DraggableDialog>
</template>
