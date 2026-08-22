import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const sourceBuildScript = path.resolve(import.meta.dirname, "../scripts/build-wasm.mjs");
const sourceCargoWrapper = path.resolve(import.meta.dirname, "../scripts/cargo-local.mjs");
const remoteLock = "remote git lock\n";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "build-wasm-"));
  const scripts = path.join(root, "scripts");
  await mkdir(scripts);
  await copyFile(sourceBuildScript, path.join(scripts, "build-wasm.mjs"));
  await copyFile(sourceCargoWrapper, path.join(scripts, "cargo-local.mjs"));
  await writeFile(path.join(root, "Cargo.lock"), remoteLock);

  const fakeWasmPack = path.join(root, "build");
  await writeFile(
    fakeWasmPack,
    'const { mkdirSync, writeFileSync } = require("node:fs");\n' +
      'const path = require("node:path");\n' +
      'writeFileSync(path.resolve("Cargo.lock"), "local path lock\\n");\n' +
      'const output = process.argv[process.argv.indexOf("--out-dir") + 1];\n' +
      "mkdirSync(output, { recursive: true });\n" +
      'writeFileSync(path.join(output, "era_web_wasm.js"), "export default 1;\\n");\n' +
      "process.exit(Number(process.env.FAKE_WASM_PACK_EXIT_CODE ?? 0));\n",
  );

  return { root, script: path.join(scripts, "build-wasm.mjs") };
}

async function runBuild(exitCode) {
  const files = await fixture();
  const result = spawnSync(process.execPath, [files.script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_WASM_PACK_EXIT_CODE: String(exitCode),
      RUSTYERA_WASM_PACK: process.execPath,
    },
  });
  return { files, result };
}

describe("WASM build launcher", () => {
  it.each([
    ["successful", 0],
    ["failed", 23],
  ])("restores Cargo.lock after a %s build", async (_outcome, exitCode) => {
    const { files, result } = await runBuild(exitCode);
    try {
      expect(result.status).toBe(exitCode);
      await expect(readFile(path.join(files.root, "Cargo.lock"), "utf8")).resolves.toBe(remoteLock);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
});
