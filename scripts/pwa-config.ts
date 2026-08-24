import type { VitePWAOptions } from "vite-plugin-pwa";

const MEBIBYTE = 1024 * 1024;

/** Browser-only installation and offline-cache policy shared by Vite and its regression tests. */
export const rustyEraPwaOptions = {
  injectRegister: "auto",
  registerType: "autoUpdate",
  includeAssets: ["apple-touch-icon.png"],
  manifest: {
    id: ".",
    name: "RustyEra",
    short_name: "RustyEra",
    description: "在浏览器中运行 Era 游戏的 RustyEra 客户端",
    lang: "zh-CN",
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: "#101114",
    theme_color: "#101114",
    categories: ["games", "entertainment"],
    icons: [
      {
        src: "pwa-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "pwa-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  },
  workbox: {
    clientsClaim: true,
    cleanupOutdatedCaches: true,
    globPatterns: ["**/*.{html,js,css,wasm,webmanifest,png,svg,ico}"],
    importScripts: ["pwa-update.js"],
    // Runtime assets carry one build fingerprint in `?v=` so Pages never combines a new Worker
    // with an old WASM module. Let that request resolve to the active worker's precache entry;
    // service-worker activation then updates the shell, Worker, module, and binary atomically.
    ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
    // The runtime WASM is intentionally precached so an installed app can cold-start offline.
    maximumFileSizeToCacheInBytes: 20 * MEBIBYTE,
    navigateFallback: "index.html",
    skipWaiting: true,
    sourcemap: false,
  },
} satisfies Partial<VitePWAOptions>;

export function rustyEraPwaOptionsForHost(
  tauriPlatform: string | undefined,
): Partial<VitePWAOptions> {
  return { ...rustyEraPwaOptions, disable: Boolean(tauriPlatform) };
}
