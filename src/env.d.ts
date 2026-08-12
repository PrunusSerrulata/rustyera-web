/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUSTYERA_TEST?: string;
  readonly VITE_RUSTYERA_TAURI_TEST?: string;
  readonly VITE_RUSTYERA_TEST_PROJECT?: string;
  readonly VITE_RUSTYERA_TEST_PROJECT_FILE?: string;
  readonly VITE_RUSTYERA_TEST_STATE?: string;
  readonly VITE_RUSTYERA_TEST_STATE_TYPE?: string;
  readonly VITE_RUSTYERA_TAURI_EXPORT_PATH?: string;
  readonly VITE_RUSTYERA_FRONTEND_VERSION: string;
  readonly VITE_RUSTYERA_CORE_VERSION: string;
}

interface Window {
  __TAURI_INTERNALS__?: unknown;
  queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string }>>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle>;
  __RUSTYERA_TEST__?: import("@/testing/control").WebTestControl;
  __RUSTYERA_TEST_DOWNLOADS__?: Array<{
    name: string;
    bytes: Uint8Array;
    size?: number;
    projectMagic?: Uint8Array;
    inputReplay?: Uint8Array;
  }>;
}

interface FileSystemHandle {
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}
