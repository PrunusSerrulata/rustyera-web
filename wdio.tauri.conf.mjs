import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL(".", import.meta.url));
const binary = path.resolve(repository, "../target/debug/era-web-tauri");

export const config = {
  runner: "local",
  specs: ["./tests/tauri/**/*.spec.mjs"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: binary,
        driverProvider: "embedded",
        captureBackendLogs: false,
        captureFrontendLogs: false,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: binary },
      "wdio:tauriServiceOptions": { driverProvider: "embedded" },
    },
  ],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 300_000 },
};
