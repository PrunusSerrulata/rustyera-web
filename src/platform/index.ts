import type { FrontendBridge } from "@/core/types";
import { BrowserBridge } from "@/platform/browserBridge";
import { TauriBridge } from "@/platform/tauriBridge";

let singleton: FrontendBridge | undefined;

export function platformBridge(): FrontendBridge {
  singleton ??= window.__TAURI_INTERNALS__ ? new TauriBridge() : new BrowserBridge();
  return singleton;
}

export function platformFrontendVersion(): string {
  const version = import.meta.env.VITE_RUSTYERA_FRONTEND_VERSION;
  return `${version}-${window.__TAURI_INTERNALS__ ? "tauri" : "wasm"}`;
}
