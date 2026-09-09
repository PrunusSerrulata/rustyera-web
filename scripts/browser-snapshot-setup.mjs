/* global document, navigator */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { projectRuntimeStorageRoot } from "./web-test-project.mjs";

// This matches importBrowserDirectory, rather than the packaged-project byte hash.
export function snapshotImportedProjectKey(project) {
  return Buffer.from(
    blake3(new TextEncoder().encode(path.basename(project).normalize("NFC").toLowerCase())),
  ).toString("hex");
}

export async function seedSnapshotRuntimeStorage(browser, { project, runtimeStorage }) {
  const profileRoot = path.relative(project, await projectRuntimeStorageRoot(project));
  const profileParts = profileRoot ? profileRoot.split(path.sep) : [];
  const storageKey = snapshotImportedProjectKey(project);
  await browser.execute(async (key) => {
    const root = await navigator.storage.getDirectory();
    const imports = await root.getDirectoryHandle(".rustyera-imports", { create: true });
    try {
      await imports.getDirectoryHandle(key);
      throw new Error("refusing to overwrite existing imported project storage");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    await imports.getDirectoryHandle(key, { create: true });
  }, storageKey);
  const files = [];
  // Match RUSTYERA_TEST_RUNTIME_STORAGE_INPUT: the input root contains data/.
  // Only runtime data is seeded; caches and preferences must remain fresh.
  async function copyDirectory(relative) {
    for (const entry of await readdir(path.join(runtimeStorage, relative), {
      withFileTypes: true,
    })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await copyDirectory(name);
      else if (entry.isFile()) {
        const hash = createHash("sha256");
        let offset = 0;
        const parts = [".rustyera-imports", storageKey, ...profileParts, ...name.split("/")];
        for await (const bytes of createReadStream(path.join(runtimeStorage, name), {
          highWaterMark: 256 * 1024,
        })) {
          hash.update(bytes);
          await browser.execute(
            async ({ parts, base64, offset }) => {
              let directory = await navigator.storage.getDirectory();
              for (const part of parts.slice(0, -1))
                directory = await directory.getDirectoryHandle(part, { create: true });
              const file = await directory.getFileHandle(parts.at(-1), { create: true });
              const writer = await file.createWritable({ keepExistingData: offset > 0 });
              try {
                await writer.seek(offset);
                await writer.write(
                  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
                );
                await writer.close();
                document.documentElement.dataset.rustyeraSnapshotStorage = `${parts.join("/")}:${offset + atob(base64).length}`;
              } catch (error) {
                await writer.abort().catch(() => undefined);
                throw error;
              }
            },
            { parts, base64: bytes.toString("base64"), offset },
          );
          offset += bytes.length;
        }
        const sha256 = hash.digest("hex");
        const observed = await browser.execute(
          async ({ parts, size }) => {
            let directory = await navigator.storage.getDirectory();
            for (const part of parts.slice(0, -1))
              directory = await directory.getDirectoryHandle(part, { create: true });
            const handle = await directory.getFileHandle(parts.at(-1), { create: size === 0 });
            const file = await handle.getFile();
            const digest = new Uint8Array(
              await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
            );
            return {
              size: file.size,
              sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
            };
          },
          { parts, size: offset },
        );
        if (observed.size !== offset || observed.sha256 !== sha256)
          throw new Error(`${name}: seeded OPFS runtime bytes differ`);
        files.push({ path: name, bytes: offset, sha256 });
      } else
        throw new Error(`${name}: runtime storage must contain only regular files/directories`);
    }
  }
  await copyDirectory("data");
  await browser.execute(() => {
    delete document.documentElement.dataset.rustyeraSnapshotStorage;
  });
  if (files.length === 0) throw new Error("snapshot runtime storage contains no data files");
  return { source: "isolated OPFS snapshot preparation", storageKey, profileParts, files };
}
