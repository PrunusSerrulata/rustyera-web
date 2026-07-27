import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:1420" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    port: 1420,
    reuseExistingServer: !process.env.CI,
  },
});
