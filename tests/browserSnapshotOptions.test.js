// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCompatibilityOptions } from "../scripts/browser-compat-options.mjs";
import { snapshotImportedProjectKey } from "../scripts/browser-snapshot-setup.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rustyera-browser-snapshot-options-"));
  directories.push(root);
  const project = path.join(root, "game");
  await mkdir(project);
  const state = path.join(root, "runtime.snapshot");
  await writeFile(state, new Uint8Array([1, 2, 3]));
  return { root, project, state, argv: ["--browser", "firefox", "--project", project] };
}

describe("explicit browser VM snapshot acceptance", () => {
  it("preserves ordinary source-project interactive defaults", async () => {
    const { argv } = await fixture();
    const options = await loadCompatibilityOptions(argv);
    expect(options.startupOnly).toBe(false);
    expect(options.runtimeState).toBeUndefined();
    expect(options.runtimeStorage).toBeUndefined();
    expect(options.snapshotXray).toBe(false);
  });

  it("loads explicit VM snapshot bytes without treating them as a traditional save", async () => {
    const { root, state, argv } = await fixture();
    const options = await loadCompatibilityOptions([
      ...argv,
      "--runtime-state",
      state,
      "--runtime-storage",
      root,
      "--snapshot-xray",
    ]);
    expect(options.runtimeState).toEqual([1, 2, 3]);
    expect(options.traditionalState).toBeUndefined();
    expect(options.runtimeStorage).toBe(root);
    expect(options.snapshotXray).toBe(true);
    expect(options.startupOnly).toBe(true);
  });

  it("retains the explicit traditional-save flow", async () => {
    const { state, argv } = await fixture();
    const options = await loadCompatibilityOptions([...argv, "--traditional-state", state]);
    expect(options.traditionalState).toEqual([1, 2, 3]);
    expect(options.runtimeState).toBeUndefined();
    expect(options.startupOnly).toBe(true);
  });

  it("rejects ambiguous restore types and unrelated fixture flows", async () => {
    const { state, argv } = await fixture();
    await expect(
      loadCompatibilityOptions([...argv, "--runtime-state", state, "--traditional-state", state]),
    ).rejects.toThrow("mutually exclusive");
    await expect(
      loadCompatibilityOptions([...argv, "--runtime-state", state, "--snake-data"]),
    ).rejects.toThrow("cannot be combined");
    await expect(
      loadCompatibilityOptions([...argv, "--runtime-state", state, "--project-file", state]),
    ).rejects.toThrow("source directory");
  });

  it("requires an explicit restore for snapshot-only options and validates missing paths", async () => {
    const { argv } = await fixture();
    await expect(loadCompatibilityOptions([...argv, "--snapshot-xray"])).rejects.toThrow(
      "require --runtime-state",
    );
    await expect(
      loadCompatibilityOptions([...argv, "--runtime-storage", "/tmp/storage"]),
    ).rejects.toThrow("require --runtime-state");
    await expect(loadCompatibilityOptions([...argv, "--runtime-state"])).rejects.toThrow(
      "requires a path",
    );
    await expect(
      loadCompatibilityOptions([...argv, "--runtime-storage", "--snapshot-xray"]),
    ).rejects.toThrow("requires a path");
  });

  it("matches imported project naming normalization independently of parent directory", () => {
    expect(snapshotImportedProjectKey("/first/Café")).toBe(
      snapshotImportedProjectKey("/second/CAFE\u0301"),
    );
    expect(snapshotImportedProjectKey("/first/game")).not.toBe(
      snapshotImportedProjectKey("/first/other"),
    );
  });
});
