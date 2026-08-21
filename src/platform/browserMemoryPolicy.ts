type BrowserHostSignals = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent"> & {
  readonly deviceMemory?: number;
  readonly userAgentData?: { readonly mobile?: boolean };
};

const LOW_MEMORY_DEVICE_GIB = 4;
const MOBILE_USER_AGENT =
  /\b(?:Android|HarmonyOS|OpenHarmony|iPad|iPhone|iPod|Mobi(?:le)?|Tablet|IEMobile|Windows Phone|Opera Mini|KaiOS)\b/i;

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
