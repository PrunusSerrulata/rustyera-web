import type { DiagnosisArchiveInput, DiagnosisArchiveProgress } from "@/core/diagnosis";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";
import { normalizeProjectFileIdentity } from "@/platform/projectFileManifestTransfer";
import type { WorkerClient } from "@/platform/workerClient";
import { downloadBrowserBlob } from "@/platform/browserDownload";

export async function saveBrowserDiagnosis(
  worker: WorkerClient,
  name: string,
  input: DiagnosisArchiveInput,
  reportProgress?: (progress: DiagnosisArchiveProgress) => void,
): Promise<boolean> {
  if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
    const prefix = new Uint8Array(4);
    const projectMagic = input.projectFile.slice(0, 8);
    const projectIdentity = normalizeProjectFileIdentity(
      await worker.call("projectFileIdentity", input.projectFile),
    );
    const inputReplay = new Uint8Array(input.inputReplay);
    let size = 0;
    const totalBytes = await streamDiagnosisArchiveInWorker(
      input,
      async (chunk) => {
        const prefixLength = Math.min(chunk.length, prefix.length - Math.min(size, prefix.length));
        if (prefixLength > 0) prefix.set(chunk.subarray(0, prefixLength), size);
        size += chunk.length;
      },
      reportProgress,
    );
    (window.__RUSTYERA_TEST_DOWNLOADS__ ??= []).push({
      name,
      bytes: prefix,
      size,
      projectMagic,
      projectIdentity,
      inputReplay,
    });
    reportProgress?.({ completed: totalBytes, total: totalBytes });
    return true;
  }

  if (window.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      throw error;
    }
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      const totalBytes = await streamDiagnosisArchiveInWorker(
        input,
        (chunk) => writer.write(chunk as FileSystemWriteChunkType),
        reportProgress,
      );
      await writer.close();
      reportProgress?.({ completed: totalBytes, total: totalBytes });
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    return true;
  }

  const storageRoot = await navigator.storage.getDirectory();
  const temporaryName = `diagnosis-${crypto.randomUUID()}.tar.zst`;
  const handle = await storageRoot.getFileHandle(temporaryName, { create: true });
  const writer = await handle.createWritable({ keepExistingData: false });
  try {
    const totalBytes = await streamDiagnosisArchiveInWorker(
      input,
      (chunk) => writer.write(chunk as FileSystemWriteChunkType),
      reportProgress,
    );
    await writer.close();
    downloadBrowserBlob(name, await handle.getFile(), () => {
      void storageRoot.removeEntry(temporaryName).catch(() => undefined);
    });
    reportProgress?.({ completed: totalBytes, total: totalBytes });
    return true;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await storageRoot.removeEntry(temporaryName).catch(() => undefined);
    throw error;
  }
}
