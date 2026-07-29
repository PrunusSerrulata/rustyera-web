import { createDiagnosisArchive, type DiagnosisArchiveInput } from "@/core/diagnosis";

self.onmessage = (event: MessageEvent<DiagnosisArchiveInput>) => {
  try {
    const archive = createDiagnosisArchive(event.data);
    self.postMessage({ archive }, { transfer: [archive.buffer] });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
