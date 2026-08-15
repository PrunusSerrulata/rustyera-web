import { vi } from "vitest";

import {
  defaultPreferences,
  type ProjectProgress,
  type RuntimeMessage,
  type SystemFontQueryResult,
} from "@/core/types";

export const bridge = {
  kind: "tauri" as "tauri" | "browser",
  createSession: vi.fn(),
  submitRuntime: vi.fn(async (_message: RuntimeMessage, _correlationId?: number) => {
    void _message;
    void _correlationId;
    return 1;
  }),
  submitDebug: vi.fn(async () => 1),
  pump: vi.fn(),
  projectProgressListener: undefined as ((progress: ProjectProgress) => void) | undefined,
  setProjectProgressListener: vi.fn(
    (listener: ((progress: ProjectProgress) => void) | undefined) => {
      bridge.projectProgressListener = listener;
    },
  ),
  openProject: vi.fn(),
  openProjectFile: vi.fn(),
  restartProject: vi.fn(),
  submitProjectSource: vi.fn(),
  prepareProjectReloadBaseline: vi.fn(),
  projectReloadTargets: vi.fn(),
  reloadProject: vi.fn(),
  finalizeProjectReload: vi.fn(),
  readResource: vi.fn(),
  readImageMetadata: vi.fn(),
  handleStorage: vi.fn(),
  listFonts: vi.fn(async (): Promise<SystemFontQueryResult> => ({ kind: "ready", fonts: [] })),
  loadPreferences: vi.fn(async () => defaultPreferences()),
  savePreferences: vi.fn(),
  projectConfigurationWritable: vi.fn(() => true),
  writeProjectConfiguration: vi.fn(),
  applyProjectConfiguration: vi.fn(),
  projectName: vi.fn(() => "eraTW"),
  openUpload: vi.fn(),
  saveDownload: vi.fn(),
  stageFullProjectManifest: vi.fn(),
  readFullProjectManifestChunk: vi.fn(),
  releaseFullProjectManifest: vi.fn(),
  beginProjectFileExport: vi.fn(),
  writeProjectFileChunk: vi.fn(),
  cancelProjectFileExport: vi.fn(),
  traditionalSaves: {
    listSlots: vi.fn(),
    exportSlot: vi.fn(),
    pickImport: vi.fn(),
    inspect: vi.fn(),
    writeSlot: vi.fn(),
  },
  saveDiagnosis: vi.fn(),
  writeCompiledCacheChunk: vi.fn(),
  cancelCompiledCacheExport: vi.fn(),
  close: vi.fn(),
};
