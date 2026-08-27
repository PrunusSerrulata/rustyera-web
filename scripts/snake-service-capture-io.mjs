import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const MiB = 1024 * 1024;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const stableJSON = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

export async function hashFile(file, maximum = 1024 * MiB) {
  const before = await lstat(file);
  requireValue(
    before.isFile() && !before.isSymbolicLink() && before.size <= maximum,
    `not a bounded regular file: ${file}`,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    requireValue(bytes <= before.size && bytes <= maximum, `file grew: ${file}`);
    hash.update(chunk);
  }
  const after = await lstat(file);
  requireValue(
    bytes === before.size &&
      before.ino === after.ino &&
      before.dev === after.dev &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs,
    `file changed: ${file}`,
  );
  return { bytes, sha256: hash.digest("hex") };
}

export async function inventory(root, { decoded = false, sourceManifest = false } = {}) {
  requireValue(!(await lstat(root)).isSymbolicLink(), "inventory root must not be a symlink");
  const files = [];
  const identities = new Set();
  let bytes = 0;
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      requireValue(name && !/[\\:\0]/u.test(name), "unsafe inventory basename");
      const relative = prefix ? `${prefix}/${name}` : name;
      if (
        !prefix &&
        sourceManifest &&
        !["src", "scripts"].includes(name) &&
        !["package.json", "index.html", "rustyera-core.rev"].includes(name) &&
        !/^vite\.config\./u.test(name) &&
        !/^tsconfig.*\.json$/u.test(name) &&
        !/^\.env/u.test(name) &&
        !/(?:^|[.-])lock(?:[.-]|$)|lock$/iu.test(name)
      )
        continue;
      const file = path.join(directory, name);
      const stat = await lstat(file);
      requireValue(!stat.isSymbolicLink(), `symlink inventory entry: ${relative}`);
      if (stat.isDirectory()) {
        await walk(file, relative);
        continue;
      }
      const key = relative.normalize("NFC").toLowerCase();
      requireValue(
        !identities.has(key) && identities.size < 100000 && Buffer.byteLength(relative) <= 4096,
        "inventory identity/size limit",
      );
      identities.add(key);
      const digest = await hashFile(file, 64 * MiB);
      bytes += digest.bytes;
      requireValue(bytes <= 512 * MiB, "inventory byte limit");
      const row = { path: relative, ...digest };
      if (decoded) {
        const raw = await readFile(file);
        requireValue(
          raw.length === digest.bytes && sha256(raw) === digest.sha256,
          `fixture changed: ${relative}`,
        );
        try {
          row.decodedUtf8Sha256 = sha256(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch {
          row.decodedUtf8Sha256 = null;
        }
      }
      files.push(row);
    }
  }
  await walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function selectCaptureCase(fixture, id) {
  const index = fixture.cases.findIndex((item) => item.id === id);
  requireValue(
    index >= 0 && fixture.cases.filter((item) => item.id === id).length === 1,
    `unknown or duplicate exact case: ${id}`,
  );
  const selected = fixture.cases[index];
  requireValue(
    selected.requests.length === 1 && selected.requests[0].request.op === "run",
    "capture supports exactly one run entry per fresh session",
  );
  return {
    selected,
    menu: String(index + 1),
    request: structuredClone(selected.requests[0].request),
  };
}

export async function captureConfiguration(arguments_, project, family, actualRuntimeFile) {
  const argument = (key) => {
    const index = arguments_.indexOf(key);
    requireValue(index >= 0 && arguments_[index + 1], `${key} is required`);
    return arguments_[index + 1];
  };
  const file = path.resolve(argument("--capture-config"));
  const config = JSON.parse(await readFile(file, "utf8"));
  const resolve = (value) => path.resolve(path.dirname(file), value);
  for (const field of [
    "fixture",
    "coreRepository",
    "frontendRepository",
    "frontendRoot",
    "runtimeArtifact",
    "clientArtifact",
    "outputDirectory",
  ])
    config[field] = resolve(config[field]);
  if (config.sourceFixtureRoot) config.sourceFixtureRoot = resolve(config.sourceFixtureRoot);
  requireValue(
    (await realpath(project)) === (await realpath(config.fixture)),
    "--project must be the exact capture fixture source",
  );
  if (actualRuntimeFile)
    requireValue(
      (await realpath(actualRuntimeFile)) === (await realpath(config.runtimeArtifact)),
      "runtime artifact differs from the launched host",
    );
  if (family === "tauri")
    requireValue(
      actualRuntimeFile &&
        (await realpath(actualRuntimeFile)) === (await realpath(config.clientArtifact)),
      "Tauri client artifact must identify the actually launched native application",
    );
  const mode = family === "tauri" ? "embedded" : "vite-dev";
  requireValue(config.mode === mode, `capture mode must be ${mode}`);
  if (mode === "vite-dev")
    requireValue(
      (await realpath(config.frontendRoot)) === (await realpath(config.frontendRepository)),
      "Vite frontend manifest root must be its real source repository",
    );
  if (mode === "vite-dev")
    requireValue(
      (await realpath(config.runtimeArtifact)) ===
        (await realpath(path.join(config.frontendRepository, "public/wasm/era_web_wasm_bg.wasm"))),
      "runtime artifact must be the actual Vite-served WASM file",
    );
  requireValue(
    ["emuera.em", "emuera.skia.snake"].includes(config.expectedProfile),
    "expectedProfile must name the effective fixture profile",
  );
  if (config.commandTimeoutMs != null)
    requireValue(
      Number.isSafeInteger(config.commandTimeoutMs) &&
        config.commandTimeoutMs > 0 &&
        config.commandTimeoutMs <= 300000,
      "commandTimeoutMs must be 1..300000",
    );
  const fixture = JSON.parse(await readFile(path.join(config.fixture, "cases.json"), "utf8"));
  requireValue(
    fixture.version === 1 && Number.isSafeInteger(fixture.seed),
    "invalid fixture version/seed",
  );
  return {
    ...config,
    mode,
    family,
    fixtureManifest: fixture,
    ...selectCaptureCase(fixture, argument("--case")),
  };
}

export async function prepareCaptureInputs(config) {
  await mkdir(config.outputDirectory, { recursive: false });
  const fixtureFiles = await inventory(config.fixture, { decoded: true });
  const sourceFixtureFiles = config.sourceFixtureRoot
    ? await inventory(config.sourceFixtureRoot, { decoded: true })
    : undefined;
  const frontendFiles = await inventory(config.frontendRoot, {
    sourceManifest: config.mode === "vite-dev",
  });
  const frontendManifest = {
    version: 1,
    kind: config.mode === "vite-dev" ? "frontend_source_manifest" : "frontend_file_manifest",
    files: frontendFiles,
  };
  const frontendPath = path.join(config.outputDirectory, "frontend-artifact.json");
  await writeFile(frontendPath, `${JSON.stringify(frontendManifest)}\n`, { flag: "wx" });
  const git = async (root, args) =>
    (
      await promisify(execFile)("git", args, { cwd: root, timeout: 10000, maxBuffer: 4 * MiB })
    ).stdout.trim();
  const coreSha = await git(config.coreRepository, ["rev-parse", "HEAD"]);
  const frontendSha = await git(config.frontendRepository, ["rev-parse", "HEAD"]);
  const dirty = Boolean(
    await git(config.coreRepository, ["status", "--porcelain", "--untracked-files=normal"]),
  );
  const frontendDirty = Boolean(
    await git(config.frontendRepository, ["status", "--porcelain", "--untracked-files=normal"]),
  );
  const pin = (
    await readFile(path.join(config.frontendRepository, "rustyera-core.rev"), "utf8")
  ).trim();
  requireValue(
    /^[0-9a-f]{40}$/u.test(coreSha) && /^[0-9a-f]{40}$/u.test(frontendSha) && pin === coreSha,
    "core source and published frontend pin are not synchronized",
  );
  const artifactPaths = {
    runtime: config.runtimeArtifact,
    frontend: frontendPath,
    client: config.clientArtifact,
  };
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(artifactPaths).map(async ([key, value]) => [key, await hashFile(value)]),
    ),
  );
  const wasmAssets =
    config.mode === "vite-dev" ? await hashWasmAssets(config.frontendRepository) : undefined;
  return {
    fixtureFiles,
    sourceFixtureFiles,
    frontendFiles,
    artifactPaths,
    artifacts,
    coreSha,
    corePin: pin,
    frontendSha,
    dirty,
    frontendDirty,
    frontendManifest,
    wasmAssets,
  };
}

async function hashWasmAssets(repository) {
  const hash = createHash("sha256"),
    files = [];
  for (const name of ["era_web_wasm.js", "era_web_wasm_bg.wasm"]) {
    const file = path.join(repository, "public/wasm", name);
    const digest = await hashFile(file);
    hash.update(name);
    hash.update("\0");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    requireValue(
      stableJSON(await hashFile(file)) === stableJSON(digest),
      "WASM asset changed while hashing",
    );
    files.push({ path: name, ...digest });
  }
  return { revision: hash.digest("hex"), files };
}

export async function assertCaptureInputsUnchanged(config, inputs) {
  requireValue(
    stableJSON(await inventory(config.fixture, { decoded: true })) ===
      stableJSON(inputs.fixtureFiles),
    "fixture changed during capture",
  );
  if (inputs.sourceFixtureFiles)
    requireValue(
      stableJSON(await inventory(config.sourceFixtureRoot, { decoded: true })) ===
        stableJSON(inputs.sourceFixtureFiles),
      "original source fixture changed during capture",
    );
  requireValue(
    stableJSON(
      await inventory(config.frontendRoot, { sourceManifest: config.mode === "vite-dev" }),
    ) === stableJSON(inputs.frontendFiles),
    "frontend inputs changed during capture",
  );
  for (const [role, file] of Object.entries(inputs.artifactPaths))
    requireValue(
      stableJSON(await hashFile(file)) === stableJSON(inputs.artifacts[role]),
      `${role} artifact changed during capture`,
    );
  if (inputs.wasmAssets)
    requireValue(
      stableJSON(await hashWasmAssets(config.frontendRepository)) === stableJSON(inputs.wasmAssets),
      "actual WASM assets changed during capture",
    );
}

export class CaptureWriter {
  constructor(directory) {
    this.directory = directory;
    this.path = path.join(directory, "capture.ndjson.gz");
    this.index = 0;
    this.bytes = 0;
    this.digest = createHash("sha256");
    this.gzip = createGzip();
    this.completion = pipeline(this.gzip, createWriteStream(this.path, { flags: "wx" }));
    this.error = undefined;
    void this.completion.catch((error) => {
      this.error = error;
    });
    this.queue = Promise.resolve();
  }
  record(packet) {
    this.queue = this.queue.then(async () => {
      if (this.error) throw this.error;
      const bytes = Buffer.from(`${JSON.stringify({ index: this.index, ...packet })}\n`);
      if (bytes.length > 32 * MiB || this.bytes + bytes.length > 512 * MiB)
        throw new Error("capture packet/total byte limit exceeded");
      this.index += 1;
      this.bytes += bytes.length;
      this.digest.update(bytes);
      if (!this.gzip.write(bytes)) await once(this.gzip, "drain");
    });
    return this.queue;
  }
  async close() {
    await this.queue;
    this.gzip.end();
    await this.completion;
    const stored = await hashFile(this.path);
    return {
      path: path.basename(this.path),
      compression: "gzip",
      storedBytes: stored.bytes,
      storedSha256: stored.sha256,
      decodedBytes: this.bytes,
      decodedSha256: this.digest.digest("hex"),
    };
  }
  async abort(error) {
    this.gzip.destroy(error);
    await this.completion.catch(() => undefined);
  }
}
