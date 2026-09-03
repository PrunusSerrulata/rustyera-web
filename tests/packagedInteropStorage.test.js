import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedPackagedInteropStorage } from "../scripts/packaged-interop-storage.mjs";
import { SaveDirectoryHandle } from "./browserProjectTestSupport";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "rustyera-interop-storage-"));
  const projectFile = path.join(directory, "fixture.reraproj");
  await writeFile(projectFile, "package bytes determine the OPFS storage key");
  const source = { "save1000.sav": Uint8Array.of(1, 2, 3), "global.sav": Uint8Array.of(4, 5) };
  const expectedHashes = {};
  for (const [name, bytes] of Object.entries(source)) {
    await writeFile(path.join(directory, name), bytes);
    expectedHashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const root = new SaveDirectoryHandle("isolated-opfs");
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  vi.stubGlobal("crypto", webcrypto);
  const browser = { execute: vi.fn((callback, argument) => callback(argument)) };
  return {
    root,
    source,
    browser,
    options: { projectFile, savesDirectory: directory, expectedHashes },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("packaged interop storage fixture", () => {
  it("writes and reads back both exact saves before gameplay without overwriting a project", async () => {
    const data = await fixture();
    try {
      const result = await seedPackagedInteropStorage(data.browser, data.options);
      expect(result.storageKey).toMatch(/^[0-9a-f]{64}$/);
      expect(result.files).toHaveLength(2);
      const projects = await data.root.getDirectoryHandle(".rustyera-project-files");
      const project = await projects.getDirectoryHandle(result.storageKey);
      const saves = await project.getDirectoryHandle("sav");
      for (const [name, expected] of Object.entries(data.source)) {
        const handle = await saves.getFileHandle(name);
        expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(expected);
        expect(result.files.find((file) => file.name === name)).toMatchObject({
          bytes: expected.length,
          sha256: data.options.expectedHashes[name],
        });
      }
      await expect(seedPackagedInteropStorage(data.browser, data.options)).rejects.toThrow(
        "refusing to overwrite",
      );
    } finally {
      await data.close();
    }
  });

  it("rejects a reference hash mismatch before touching browser storage", async () => {
    const data = await fixture();
    try {
      data.options.expectedHashes["global.sav"] = "not the reference hash";
      await expect(seedPackagedInteropStorage(data.browser, data.options)).rejects.toThrow(
        "global.sav: reference fixture hash",
      );
      expect(data.browser.execute).not.toHaveBeenCalled();
    } finally {
      await data.close();
    }
  });
});
