import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const browserPath = fileURLToPath(new URL("../.playwright-browsers", import.meta.url));
const cliPath = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || browserPath,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
