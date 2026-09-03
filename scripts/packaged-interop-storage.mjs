/* global navigator */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";

/** Project packages contain program/resources, not writable saves. Seed the isolated
 * browser's real OPFS project before opening it; gameplay still reads through the host. */
export async function seedPackagedInteropStorage(
  browser,
  { projectFile, savesDirectory, expectedHashes },
) {
  const hash = blake3.create();
  for await (const chunk of createReadStream(projectFile)) hash.update(Uint8Array.from(chunk));
  const storageKey = Buffer.from(hash.digest()).toString("hex");
  const files = await Promise.all(
    ["save1000.sav", "global.sav"].map(async (name) => {
      const bytes = await readFile(path.join(savesDirectory, name));
      assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, "interop fixture save size");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, expectedHashes?.[name], `${name}: reference fixture hash`);
      return { name, bytes: [...bytes], sha256 };
    }),
  );
  return browser.execute(
    async ({ storageKey, files }) => {
      const root = await navigator.storage.getDirectory();
      const projects = await root.getDirectoryHandle(".rustyera-project-files", { create: true });
      try {
        await projects.getDirectoryHandle(storageKey);
        throw new Error("refusing to overwrite existing packaged project storage");
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      const project = await projects.getDirectoryHandle(storageKey, { create: true });
      const saves = await project.getDirectoryHandle("sav", { create: true });
      const observed = [];
      for (const { name, bytes, sha256 } of files) {
        const handle = await saves.getFileHandle(name, { create: true });
        const writer = await handle.createWritable({ keepExistingData: false });
        try {
          await writer.write(Uint8Array.from(bytes));
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => undefined);
          throw error;
        }
        const restored = await (await handle.getFile()).arrayBuffer();
        const digest = [
          ...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", restored)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== sha256) throw new Error(`${name}: OPFS fixture bytes differ`);
        observed.push({ name, bytes: restored.byteLength, sha256: digest });
      }
      return { source: "isolated OPFS fixture preparation", storageKey, files: observed };
    },
    { storageKey, files },
  );
}
