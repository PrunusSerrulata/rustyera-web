<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { BROWSER_FILE_SAVE_EVENT, type BrowserFileSaveRequest } from "@/platform/browserDownload";

const pending = ref<BrowserFileSaveRequest[]>([]);
const busy = ref(false);
const error = ref("");
const downloading = computed(() => pending.value[0]?.mode === "download");
let active: BrowserFileSaveRequest | undefined;
let unmounted = false;

function receive(event: Event): void {
  const request = (event as CustomEvent<BrowserFileSaveRequest>).detail;
  if (!(request?.file instanceof File)) return;
  if (request.release != null && typeof request.release !== "function") return;
  if (request.mode != null && request.mode !== "share" && request.mode !== "download") return;
  pending.value.push(request);
}

function release(request: BrowserFileSaveRequest | undefined): void {
  try {
    request?.release?.();
  } catch {
    // The backing resource is best-effort cleanup and must not break dialog queue ownership.
  }
}

function removeCurrent(): void {
  release(pending.value.shift());
}

function remove(request: BrowserFileSaveRequest): void {
  const index = pending.value.indexOf(request);
  if (index >= 0) release(pending.value.splice(index, 1)[0]);
}

function close(): void {
  if (busy.value || downloading.value) return;
  removeCurrent();
  error.value = "";
}

async function save(): Promise<void> {
  const request = pending.value[0];
  if (!request) return;
  active = request;
  busy.value = true;
  error.value = "";
  try {
    await navigator.share({ files: [request.file], title: request.file.name });
    remove(request);
  } catch (cause) {
    if (unmounted) {
      remove(request);
      return;
    }
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    active = undefined;
    busy.value = false;
  }
}

onMounted(() => window.addEventListener(BROWSER_FILE_SAVE_EVENT, receive));
onBeforeUnmount(() => {
  unmounted = true;
  window.removeEventListener(BROWSER_FILE_SAVE_EVENT, receive);
  for (const request of [...pending.value]) {
    // Closing the page does not prove that its browser download has finished.
    if (request !== active && request.mode !== "download") remove(request);
  }
});
</script>

<template>
  <DraggableDialog
    :open="pending.length > 0"
    :title="downloading ? '文件下载已开始' : '保存导出文件'"
    :close-disabled="busy || downloading"
    @close="close"
  >
    <p v-if="downloading">
      请在浏览器中查看下载进度。下载完成或取消后，点击“下载已结束”关闭此窗口。
    </p>
    <p v-else>Firefox iOS 无法为网页生成的下载保留文件名。请通过系统分享菜单存储此文件。</p>
    <p v-if="pending[0]"><strong>文件名：</strong>{{ pending[0].file.name }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <footer v-if="downloading" class="dialog-actions">
      <span class="spacer" />
      <button type="button" class="primary" @click="removeCurrent">下载已结束</button>
    </footer>
    <footer v-else class="dialog-actions">
      <button type="button" :disabled="busy" @click="close">取消</button>
      <span class="spacer" />
      <button type="button" class="primary" :disabled="busy" @click="save">
        {{ busy ? "正在打开…" : "打开系统分享菜单" }}
      </button>
    </footer>
  </DraggableDialog>
</template>
