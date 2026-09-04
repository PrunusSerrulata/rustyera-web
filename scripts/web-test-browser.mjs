/* global document, window */

import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function nativeFirefoxCapabilities(platform = process.platform, { headless = true } = {}) {
  const options = { args: headless ? ["-headless"] : [] };
  const geckoDriverVersion = "0.37.1";
  if (platform === "darwin") {
    options.binary = "/Applications/Firefox.app/Contents/MacOS/firefox";
  }
  return {
    browserName: "firefox",
    // Returning before the load event keeps classic Marionette commands available while the
    // compatibility client performs long-running WASM startup work. BiDi session negotiation has
    // proven less reliable than Firefox's stable WebDriver HTTP endpoint on release builds.
    pageLoadStrategy: "none",
    "wdio:enforceWebDriverClassic": true,
    "wdio:geckodriverOptions": {
      binary: path.resolve(".rustyera", "webdriver", `geckodriver-${geckoDriverVersion}`),
      geckoDriverVersion,
    },
    "moz:firefoxOptions": options,
  };
}

export async function waitForWebDriverDocument(
  browser,
  expectedUrl,
  { timeoutMs = 5_000, stage = "waiting for target document" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = { url: null, readyState: null };
  let lastError;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      last = await deadlineRace(
        browser.execute(() => ({
          url: window.location.href,
          readyState: document.readyState,
        })),
        remaining,
        "document readiness probe",
      );
      if (last.url?.startsWith(expectedUrl) && last.readyState !== "loading") return last;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  throw new Error(
    `WebDriver target document did not become ready during ${stage}: ${JSON.stringify({
      expectedUrl,
      ...last,
      error: lastError?.message ?? null,
    })}`,
  );
}

async function deadlineRace(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function installRemoteFileSystem(page, root) {
  const writers = new Map();
  let nextWriter = 0;
  const safe = (relative) => {
    const resolved = path.resolve(root, relative || ".");
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      throw new Error(`project path escapes root: ${relative}`);
    return resolved;
  };
  await page.exposeBinding("__rustyeraFs", async (_source, request) => {
    const target = safe(request.path);
    if (request.op === "entries") {
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      }));
    }
    if (request.op === "stat") {
      const stat = await lstat(target, { bigint: true });
      return {
        size: Number(stat.size),
        kind: stat.isDirectory() ? "directory" : "file",
        lastModified: Number(stat.mtimeNs / 1_000_000n),
      };
    }
    if (request.op === "mkdir") return mkdir(target, { recursive: true }).then(() => true);
    if (request.op === "open_writer") {
      await mkdir(path.dirname(target), { recursive: true });
      const id = String(++nextWriter);
      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.rustyera-test-${id}.tmp`,
      );
      const handle = await open(temporary, "w");
      writers.set(id, { handle, target, temporary });
      return id;
    }
    if (request.op === "write_chunk") {
      const writer = writers.get(String(request.writer));
      if (!writer) throw new Error(`unknown filesystem writer ${request.writer}`);
      await writer.handle.write(Buffer.from(String(request.data), "base64"));
      return true;
    }
    if (request.op === "close_writer") {
      const id = String(request.writer);
      const writer = writers.get(id);
      if (!writer) throw new Error(`unknown filesystem writer ${request.writer}`);
      writers.delete(id);
      await writer.handle.close();
      await rename(writer.temporary, writer.target);
      return true;
    }
    if (request.op === "abort_writer") {
      const id = String(request.writer);
      const writer = writers.get(id);
      if (!writer) return true;
      writers.delete(id);
      await writer.handle.close();
      await rm(writer.temporary, { force: true });
      return true;
    }
    if (request.op === "write") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(request.data));
      return true;
    }
    if (request.op === "delete")
      return rm(target, { force: true, recursive: true }).then(() => true);
    throw new Error(`unknown filesystem operation ${request.op}`);
  });
  await page.exposeBinding("__rustyeraReplaceProjectSource", async (_source, request) => {
    const target = safe(request.relativePath);
    const source = await readFile(target, "utf8");
    if (source.split(request.expected).length !== 2)
      throw new Error(`source edit expected text must occur exactly once: ${request.relativePath}`);
    await writeFile(target, source.replace(request.expected, request.replacement), "utf8");
  });
  await page.addInitScript(() => {
    const FILE_WRITE_CHUNK_BYTES = 1024 * 1024;
    const base64 = (bytes) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    };
    const callFileSystem = async (request) => {
      try {
        return await window.__rustyeraFs(request);
      } catch (error) {
        const message = String(error);
        if (message.includes("ENOENT")) throw new DOMException(message, "NotFoundError");
        if (message.includes("EACCES") || message.includes("EPERM"))
          throw new DOMException(message, "NotAllowedError");
        throw error;
      }
    };
    class RemoteFileHandle {
      kind = "file";
      constructor(name, relativePath) {
        this.name = name;
        this.relativePath = relativePath;
      }
      async getFile() {
        const stat = await callFileSystem({ op: "stat", path: this.relativePath });
        const response = await fetch(
          `/__rustyera_test_file?path=${encodeURIComponent(this.relativePath)}`,
        );
        if (response.status === 404)
          throw new DOMException(`File not found: ${this.relativePath}`, "NotFoundError");
        if (!response.ok) throw new Error(`cannot read test file: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== stat.size)
          throw new Error(`test file changed while reading: ${this.relativePath}`);
        return new File([bytes], this.name, { lastModified: stat.lastModified });
      }
      async createWritable() {
        const writer = await callFileSystem({ op: "open_writer", path: this.relativePath });
        let active = true;
        return {
          write: async (value) => {
            if (!active) throw new DOMException("Writer is closed", "InvalidStateError");
            const data =
              value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
            for (let offset = 0; offset < data.length; offset += FILE_WRITE_CHUNK_BYTES) {
              await callFileSystem({
                op: "write_chunk",
                writer,
                data: base64(data.subarray(offset, offset + FILE_WRITE_CHUNK_BYTES)),
              });
            }
          },
          close: async () => {
            if (!active) return;
            active = false;
            await callFileSystem({ op: "close_writer", path: this.relativePath, writer });
          },
          abort: async () => {
            if (!active) return;
            active = false;
            await callFileSystem({ op: "abort_writer", path: this.relativePath, writer });
          },
        };
      }
      queryPermission = async () => "granted";
      requestPermission = async () => "granted";
    }
    class RemoteDirectoryHandle {
      kind = "directory";
      constructor(name, relativePath = "") {
        this.name = name;
        this.relativePath = relativePath;
      }
      child(name) {
        return this.relativePath ? `${this.relativePath}/${name}` : name;
      }
      async *entries() {
        for (const entry of await callFileSystem({ op: "entries", path: this.relativePath }))
          yield [
            entry.name,
            entry.kind === "directory"
              ? new RemoteDirectoryHandle(entry.name, this.child(entry.name))
              : new RemoteFileHandle(entry.name, this.child(entry.name)),
          ];
      }
      async getDirectoryHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await callFileSystem({ op: "mkdir", path: relative });
        // Native handles reject missing directories before returning a usable handle. Returning a
        // phantom handle turns an ordinary Data miss into a later traversal-conflict error.
        const metadata = await callFileSystem({ op: "stat", path: relative });
        if (metadata.kind !== "directory")
          throw new DOMException(`Not a directory: ${relative}`, "TypeMismatchError");
        return new RemoteDirectoryHandle(name, relative);
      }
      async getFileHandle(name, options = {}) {
        const relative = this.child(name);
        if (options.create) await callFileSystem({ op: "write", path: relative, data: [] });
        else await callFileSystem({ op: "stat", path: relative });
        return new RemoteFileHandle(name, relative);
      }
      removeEntry(name) {
        return callFileSystem({ op: "delete", path: this.child(name) });
      }
      queryPermission = async () => "granted";
      requestPermission = async () => "granted";
    }
    window.showDirectoryPicker = async () => new RemoteDirectoryHandle("project");
    window.__RUSTYERA_TEST_FS_REPLACE__ = (request) =>
      window.__rustyeraReplaceProjectSource(request);
  });
}
