import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPack = process.env.RUSTYERA_WASM_PACK || "wasm-pack";
const cargoLocal = resolve(frontendRoot, "scripts/cargo-local.mjs");
const environment = { ...process.env };
const publicRoot = resolve(frontendRoot, "public");
const outputDirectory = resolve(publicRoot, "wasm");
mkdirSync(publicRoot, { recursive: true });
const stagingDirectory = mkdtempSync(resolve(publicRoot, ".wasm-build-"));

if (process.platform === "darwin" && !environment.CC_wasm32_unknown_unknown) {
  const zig = spawnSync("zig", ["version"], { stdio: "ignore" });
  if (zig.status === 0) {
    environment.CC_wasm32_unknown_unknown = resolve(frontendRoot, "scripts/zig-wasm-cc.sh");
    environment.AR_wasm32_unknown_unknown ||= "zig ar";
  }
}

let result;
try {
  result = spawnSync(
    process.execPath,
    [cargoLocal, "build", "crates/era-web-wasm", "--target", "web", "--out-dir", stagingDirectory],
    {
      cwd: frontendRoot,
      env: { ...environment, RUSTYERA_CARGO: wasmPack },
      stdio: "inherit",
    },
  );

  if (!result.error && result.status === 0) {
    mkdirSync(outputDirectory, { recursive: true });
    cpSync(stagingDirectory, outputDirectory, { recursive: true, force: true });
  }
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}

if (result.error) {
  console.error(`无法启动 wasm-pack：${result.error.message}`);
  process.exit(127);
}
process.exit(result.status ?? 1);
