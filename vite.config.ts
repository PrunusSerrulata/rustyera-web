import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);
const coreRevision = readFileSync(
  fileURLToPath(new URL("./rustyera-core.rev", import.meta.url)),
  "utf8",
).trim();
const coreLock = readFileSync(fileURLToPath(new URL("./Cargo.lock", import.meta.url)), "utf8");
const coreVersion = coreLock.match(/name = "era-runtime"\nversion = "([^"]+)"/)?.[1] ?? "unknown";

export default defineConfig({
  plugins: [vue()],
  define: {
    "import.meta.env.VITE_RUSTYERA_FRONTEND_VERSION": JSON.stringify(packageJson.version),
    "import.meta.env.VITE_RUSTYERA_CORE_VERSION": JSON.stringify(
      `${coreVersion} (${coreRevision.slice(0, 8)})`,
    ),
  },
  clearScreen: false,
  server: { strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/tauri/**"],
    setupFiles: ["./tests/setup.ts"],
  },
});
