type BrowserDevice = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent">;

export function needsLowMemoryProjectFileLoad(device: BrowserDevice = navigator): boolean {
  if (/\b(?:iPad|iPhone|iPod)\b/i.test(device.userAgent ?? "")) return true;
  // iPadOS desktop browsing deliberately presents a macOS user agent and platform.
  return /^Mac/i.test(device.platform ?? "") && (device.maxTouchPoints ?? 0) > 1;
}
