import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sourceScript = path.resolve(import.meta.dirname, "../scripts/pin-core-dependencies.mjs");
const source = 'git = "https://github.com/PrunusSerrulata/rustyera-core.git"';
const oldRevision = "1".repeat(40);
const newRevision = "2".repeat(40);

async function fixture(revision) {
  const root = await mkdtemp(path.join(tmpdir(), "pin-core-dependencies-"));
  const scripts = path.join(root, "scripts");
  await mkdir(scripts);
  await copyFile(sourceScript, path.join(scripts, "pin-core-dependencies.mjs"));
  const dependency = revision === undefined ? source : `${source}, rev = "${revision}"`;
  const manifest = Array.from(
    { length: 5 },
    (_, index) => `core-${index} = { ${dependency} }`,
  ).join("\n");
  await writeFile(path.join(root, "Cargo.toml"), `${manifest}\n`);
  return { root, script: path.join(scripts, "pin-core-dependencies.mjs") };
}

function run(script) {
  return spawnSync(process.execPath, [script, newRevision], { encoding: "utf8" });
}

async function expectPinned(root) {
  const manifest = await readFile(path.join(root, "Cargo.toml"), "utf8");
  expect(manifest.match(/rev = "[^"]+"/g)).toEqual(Array(5).fill(`rev = "${newRevision}"`));
  await expect(readFile(path.join(root, "rustyera-core.rev"), "utf8")).resolves.toBe(
    `${newRevision}\n`,
  );
}

describe("core dependency pinning", () => {
  it("adds a revision to unpinned dependencies", async () => {
    const files = await fixture();

    expect(run(files.script).status).toBe(0);
    await expectPinned(files.root);
  });

  it("replaces existing revisions without creating duplicate TOML keys", async () => {
    const files = await fixture(oldRevision);

    expect(run(files.script).status).toBe(0);
    await expectPinned(files.root);
  });

  it("is idempotent", async () => {
    const files = await fixture(oldRevision);

    expect(run(files.script).status).toBe(0);
    expect(run(files.script).status).toBe(0);
    await expectPinned(files.root);
  });
});
