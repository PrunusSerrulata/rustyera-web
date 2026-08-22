type BrowserHostSignals = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  readonly deviceMemory?: number;
  readonly userAgentData?: { readonly mobile?: boolean };
};

const LOW_MEMORY_DEVICE_GIB = 4;
const MOBILE_USER_AGENT =
  /\b(?:Android|HarmonyOS|OpenHarmony|iPad|iPhone|iPod|Mobi(?:le)?|Tablet|IEMobile|Windows Phone|Opera Mini|KaiOS)\b/i;

export function isAndroidBrowserHost(host: Pick<BrowserHostSignals, "userAgent">): boolean {
  return /\bAndroid\b/i.test(host.userAgent ?? "");
}

export function isAndroidFirefoxHost(host: Pick<BrowserHostSignals, "userAgent">): boolean {
  return isAndroidBrowserHost(host) && /\bFirefox\//i.test(host.userAgent ?? "");
}

export function browserProjectFileReadConcurrency(
  host: Pick<BrowserHostSignals, "userAgent"> = navigator,
): number {
  // Android directory handles and input Files are backed by Storage Access Framework providers.
  // Bound concurrent provider calls independently from the wider mobile-memory policy; Apple
  // browsers use a different picker implementation and retain their established I/O behavior.
  return isAndroidChromiumHost(host) ? 4 : isAndroidBrowserHost(host) ? 2 : 8;
}

export function browserProjectDirectoryReadConcurrency(
  host: Pick<BrowserHostSignals, "userAgent"> = navigator,
): number {
  // Chromium's Android directory provider benefits from overlapping independent directory
  // enumerations, while individual file operations remain effectively serialized by SAF.
  // Keep every other browser on the established single-directory traversal path.
  return isAndroidChromiumHost(host) ? 8 : 1;
}

export function browserProjectScanConcurrency(
  host: BrowserHostSignals = navigator as BrowserHostSignals,
): number {
  if (isAndroidChromiumHost(host)) return 4;
  return isMemoryConstrainedBrowserHost(host) ? 2 : 8;
}

export function isAndroidChromiumHost(host: Pick<BrowserHostSignals, "userAgent">): boolean {
  const userAgent = host.userAgent ?? "";
  return isAndroidBrowserHost(host) && /\b(?:Chrome|Chromium)\//i.test(userAgent);
}

export function isMemoryConstrainedBrowserHost(
  host: BrowserHostSignals = navigator as BrowserHostSignals,
): boolean {
  const userAgent = host.userAgent ?? "";
  if (host.userAgentData?.mobile === true || MOBILE_USER_AGENT.test(userAgent)) return true;
  // iPadOS desktop browsing deliberately presents a macOS user agent and platform. Requiring
  // AppleWebKit prevents desktop Firefox touch-point overrides from selecting the iPad path.
  if (
    /\bAppleWebKit\//i.test(userAgent) &&
    /^Mac/i.test(host.platform ?? "") &&
    (host.maxTouchPoints ?? 0) > 1
  ) {
    return true;
  }
  const deviceMemory = host.deviceMemory;
  return (
    typeof deviceMemory === "number" &&
    Number.isFinite(deviceMemory) &&
    deviceMemory > 0 &&
    deviceMemory <= LOW_MEMORY_DEVICE_GIB
  );
}
