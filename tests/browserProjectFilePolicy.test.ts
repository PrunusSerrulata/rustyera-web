import { describe, expect, it } from "vitest";

import { needsLowMemoryProjectFileLoad } from "@/platform/browserProjectFilePolicy";

describe("browser project-file policy", () => {
  it.each([
    {
      browser: "iOS Safari",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    {
      browser: "iOS Firefox",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    },
    {
      browser: "iPadOS desktop mode",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  ])("uses the low-memory path for $browser", ({ userAgent, platform, maxTouchPoints }) => {
    expect(needsLowMemoryProjectFileLoad({ userAgent, platform, maxTouchPoints })).toBe(true);
  });

  it.each([
    {
      browser: "desktop Safari",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    {
      browser: "desktop Firefox",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
    {
      browser: "desktop Firefox with overridden touch points",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  ])(
    "keeps the desktop project-file policy for $browser",
    ({ userAgent, platform, maxTouchPoints }) => {
      expect(needsLowMemoryProjectFileLoad({ userAgent, platform, maxTouchPoints })).toBe(false);
    },
  );
});
