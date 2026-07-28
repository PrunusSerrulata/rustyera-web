/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown;
  queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string }>>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
  __RUSTYERA_TEST__?: import("@/testing/control").WebTestControl;
  __RUSTYERA_TEST_DOWNLOADS__?: Array<{ name: string; bytes: Uint8Array }>;
}

interface FileSystemHandle {
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}
