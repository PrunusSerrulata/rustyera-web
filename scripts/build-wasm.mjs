import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPack = process.env.RUSTYERA_WASM_PACK || "wasm-pack";
const environment = { ...process.env };

if (process.platform === "darwin" && !environment.CC_wasm32_unknown_unknown) {
  const zig = spawnSync("zig", ["version"], { stdio: "ignore" });
  if (zig.status === 0) {
    environment.CC_wasm32_unknown_unknown = resolve(frontendRoot, "scripts/zig-wasm-cc.sh");
    environment.AR_wasm32_unknown_unknown ||= "zig ar";
  }
}

const result = spawnSync(
  wasmPack,
  ["build", "crates/era-web-wasm", "--target", "web", "--out-dir", "../../public/wasm"],
  {
    cwd: frontendRoot,
    env: environment,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`无法启动 wasm-pack：${result.error.message}`);
  process.exit(127);
}
process.exit(result.status ?? 1);
