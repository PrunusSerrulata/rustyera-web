import { describe, expect, it } from "vitest";

import {
  browserProjectDirectoryReadConcurrency,
  browserProjectFileReadConcurrency,
  browserProjectScanConcurrency,
  isAndroidBrowserHost,
  isAndroidChromiumHost,
  isAndroidFirefoxHost,
  isMemoryConstrainedBrowserHost,
} from "@/platform/browserMemoryPolicy";

describe("browser memory policy", () => {
  it("isolates Android provider I/O from the established Apple picker path", () => {
    const android = {
      userAgent: "Mozilla/5.0 (Android 17; Mobile; rv:154.0) Gecko/154.0 Firefox/154.0",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    };
    const androidChrome = {
      userAgent:
        "Mozilla/5.0 (Linux; Android 17; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    };
    const ios = {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    };
    const ipados = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    };

    expect(isAndroidBrowserHost(android)).toBe(true);
    expect(isAndroidFirefoxHost(android)).toBe(true);
    expect(browserProjectFileReadConcurrency(android)).toBe(2);
    expect(browserProjectDirectoryReadConcurrency(android)).toBe(1);
    expect(browserProjectScanConcurrency(android)).toBe(2);
    expect(browserProjectFileReadConcurrency(androidChrome)).toBe(4);
    expect(browserProjectDirectoryReadConcurrency(androidChrome)).toBe(8);
    expect(browserProjectScanConcurrency(androidChrome)).toBe(4);
    expect(isAndroidChromiumHost(androidChrome)).toBe(true);
    expect(isAndroidFirefoxHost(androidChrome)).toBe(false);
    expect(isAndroidBrowserHost(ios)).toBe(false);
    expect(isAndroidChromiumHost(ios)).toBe(false);
    expect(browserProjectFileReadConcurrency(ios)).toBe(8);
    expect(browserProjectDirectoryReadConcurrency(ios)).toBe(1);
    expect(browserProjectScanConcurrency(ios)).toBe(2);
    expect(isAndroidBrowserHost(ipados)).toBe(false);
    expect(isAndroidChromiumHost(ipados)).toBe(false);
    expect(isAndroidFirefoxHost(ipados)).toBe(false);
    expect(browserProjectFileReadConcurrency(ipados)).toBe(8);
    expect(browserProjectDirectoryReadConcurrency(ipados)).toBe(1);
    expect(browserProjectScanConcurrency(ipados)).toBe(2);
  });

  it.each([
    {
      host: "Chromium mobile client hint",
      device: {
        userAgentData: { mobile: true },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
        deviceMemory: 8,
      },
    },
    {
      host: "iOS Safari",
      device: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
    },
    {
      host: "iOS Firefox",
      device: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
    },
    {
      host: "iPadOS desktop mode",
      device: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
    },
    {
      host: "Android Chrome",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "Android Firefox tablet",
      device: {
        userAgent: "Mozilla/5.0 (Android 15; Tablet; rv:142.0) Gecko/142.0 Firefox/142.0",
        platform: "Linux armv8l",
        maxTouchPoints: 10,
      },
    },
    {
      host: "Samsung Internet tablet",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 10,
      },
    },
    {
      host: "Android Edge",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "Android Opera",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 OPR/92.0.0.0",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "HarmonyOS ArkWeb",
      device: {
        userAgent:
          "Mozilla/5.0 (Phone; OpenHarmony 6.0) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.0.0.42 Mobile",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "HarmonyOS browser without a form-factor token",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; HarmonyOS 5.0) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 HuaweiBrowser/16.0",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "OpenHarmony browser without a form-factor token",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; OpenHarmony 6.0) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.0.0.42",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      },
    },
    {
      host: "4 GiB Chromium desktop",
      device: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
        platform: "Win32",
        maxTouchPoints: 0,
        deviceMemory: 4,
      },
    },
    {
      host: "2 GiB Chromium desktop",
      device: {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
        deviceMemory: 2,
      },
    },
  ])("uses the constrained-memory strategy for $host", ({ device }) => {
    expect(isMemoryConstrainedBrowserHost(device)).toBe(true);
  });

  it.each([
    {
      host: "8 GiB Chromium desktop",
      deviceMemory: 8,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
      platform: "Win32",
      maxTouchPoints: 0,
    },
    {
      host: "desktop Safari",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    {
      host: "desktop Firefox",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    {
      host: "desktop Firefox with overridden touch points",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
    {
      host: "high-memory touch desktop",
      deviceMemory: 16,
      userAgentData: { mobile: false },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
      platform: "Win32",
      maxTouchPoints: 10,
    },
    {
      host: "Samsung DeX desktop mode",
      deviceMemory: 8,
      userAgentData: { mobile: false },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36",
      platform: "Linux x86_64",
      maxTouchPoints: 5,
    },
  ])("keeps the desktop strategy for $host", (device) => {
    expect(isMemoryConstrainedBrowserHost(device)).toBe(false);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "ignores an invalid device-memory value: %s",
    (deviceMemory) => {
      expect(
        isMemoryConstrainedBrowserHost({
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/142.0",
          platform: "Linux x86_64",
          maxTouchPoints: 0,
          deviceMemory,
        }),
      ).toBe(false);
    },
  );
});
