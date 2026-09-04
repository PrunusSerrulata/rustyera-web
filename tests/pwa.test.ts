import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rustyEraPwaOptions, rustyEraPwaOptionsForHost } from "../scripts/pwa-config";

describe("browser PWA configuration", () => {
  it("provides a standalone install manifest with standard-size icons", () => {
    const manifest = rustyEraPwaOptions.manifest!;

    expect(manifest).toMatchObject({
      name: "RustyEra",
      start_url: ".",
      scope: ".",
      display: "standalone",
      theme_color: "#101114",
      background_color: "#101114",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ sizes: "512x512", type: "image/png" }),
      ]),
    );
  });

  it("activates updates and refreshes existing clients without waiting for them to close", () => {
    expect(rustyEraPwaOptions.injectRegister).toBe("auto");
    expect(rustyEraPwaOptions.registerType).toBe("autoUpdate");
    expect(rustyEraPwaOptions.workbox?.clientsClaim).toBe(true);
    expect(rustyEraPwaOptions.workbox?.skipWaiting).toBe(true);
    expect(rustyEraPwaOptions.workbox?.importScripts).toContain("pwa-update.js");
  });

  it("precaches the application shell and large runtime WASM", () => {
    expect(rustyEraPwaOptions.workbox?.globPatterns).toContain(
      "**/*.{html,js,css,wasm,webmanifest,png,svg,ico}",
    );
    expect(rustyEraPwaOptions.workbox?.maximumFileSizeToCacheInBytes).toBe(24 * 1024 * 1024);
    expect(rustyEraPwaOptions.workbox?.navigateFallback).toBe("index.html");
    expect(
      rustyEraPwaOptions.workbox?.ignoreURLParametersMatching?.some((pattern) => pattern.test("v")),
    ).toBe(true);
  });

  it("disables service workers in the Tauri host", () => {
    expect(rustyEraPwaOptionsForHost(undefined).disable).toBe(false);
    expect(rustyEraPwaOptionsForHost("macos").disable).toBe(true);
  });

  it("provides Safari installation metadata in the browser shell", () => {
    const html = readFileSync("index.html", "utf8");

    expect(html).toContain('<meta name="theme-color" content="#101114" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });
});
