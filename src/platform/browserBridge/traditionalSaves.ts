import type { TraditionalSaveAccess } from "@/core/types";
import { pickBrowserFile } from "@/platform/browserDirectory";
import { saveSlotName, type BrowserProject } from "@/platform/browserProject";
import type { WorkerClient } from "@/platform/workerClient";

interface TraditionalSaveContext {
  project(): BrowserProject;
  worker: WorkerClient;
  download(name: string, bytes: Uint8Array): void;
}

/** Browser-only traditional-save adapter; the bridge keeps its stable facade. */
export function browserTraditionalSaves(context: TraditionalSaveContext): TraditionalSaveAccess {
  return {
    listSlots: async () => {
      const project = context.project();
      const count = await context.worker.call<number>("traditionalSaveSlotCount");
      return project.listTraditionalSaveSlots(count);
    },
    exportSlot: async (slot) => {
      const bytes = await context.project().readTraditionalSave(slot);
      context.download(saveSlotName(slot), bytes);
    },
    pickImport: async () => {
      const file = await pickBrowserFile(".sav,application/octet-stream");
      return file
        ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
        : undefined;
    },
    inspect: (bytes) => context.worker.call("inspectTraditionalSave", bytes),
    writeSlot: (slot, bytes) => context.project().writeTraditionalSave(slot, bytes),
  };
}
