import type { FrontendBridge } from "@/core/types";
import { BrowserBridge } from "@/platform/browserBridge";
import { TauriBridge } from "@/platform/tauriBridge";

let singleton: FrontendBridge | undefined;

export function platformBridge(): FrontendBridge {
  singleton ??= window.__TAURI_INTERNALS__ ? new TauriBridge() : new BrowserBridge();
  return singleton;
}
