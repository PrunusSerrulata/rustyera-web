import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sourceWrapper = path.resolve(import.meta.dirname, "../scripts/cargo-local.mjs");
const remoteLock = "remote git lock\n";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cargo-local-"));
  const scripts = path.join(root, "scripts");
  await mkdir(scripts);
  await copyFile(sourceWrapper, path.join(scripts, "cargo-local.mjs"));
  await writeFile(path.join(root, "Cargo.lock"), remoteLock);
  const fakeCargo = path.join(root, "fake-cargo.mjs");
  await writeFile(
    fakeCargo,
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(new URL("Cargo.lock", `file://${process.cwd()}/`), "local path lock\\n");\n' +
      "process.exit(Number(process.argv[2] ?? 0));\n",
  );
  return { fakeCargo, root, wrapper: path.join(scripts, "cargo-local.mjs") };
}

function run({ fakeCargo, wrapper }, exitCode = 0) {
  return spawnSync(process.execPath, [wrapper, fakeCargo, String(exitCode)], {
    encoding: "utf8",
    env: { ...process.env, RUSTYERA_CARGO: process.execPath },
  });
}

describe("local Cargo wrapper", () => {
  it("restores the remote lockfile after a successful local build", async () => {
    const files = await fixture();
    const result = run(files);

    expect(result.status).toBe(0);
    await expect(readFile(path.join(files.root, "Cargo.lock"), "utf8")).resolves.toBe(remoteLock);
  });

  it("restores the remote lockfile when Cargo fails", async () => {
    const files = await fixture();
    const result = run(files, 23);

    expect(result.status).toBe(23);
    await expect(readFile(path.join(files.root, "Cargo.lock"), "utf8")).resolves.toBe(remoteLock);
  });

  it("recovers a lockfile left by an interrupted previous run", async () => {
    const files = await fixture();
    const state = path.join(files.root, ".rustyera", "cargo-local");
    await mkdir(state, { recursive: true });
    await writeFile(path.join(files.root, "Cargo.lock"), "abandoned local lock\n");
    await writeFile(path.join(state, "Cargo.lock.remote"), remoteLock);
    await writeFile(path.join(state, "owner.json"), '{"pid":99999999}\n');

    const result = run(files);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("已从异常中断的本地 Cargo 命令恢复 Cargo.lock");
    await expect(readFile(path.join(files.root, "Cargo.lock"), "utf8")).resolves.toBe(remoteLock);
  });

  it("does not recover another command while it is initializing", async () => {
    const files = await fixture();
    const state = path.join(files.root, ".rustyera", "cargo-local");
    await mkdir(state, { recursive: true });

    const result = run(files);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("另一个本地 Cargo 命令正在初始化");
    await expect(readFile(path.join(files.root, "Cargo.lock"), "utf8")).resolves.toBe(remoteLock);
  });
});
