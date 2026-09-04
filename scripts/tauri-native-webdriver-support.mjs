import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const PACKAGE = "tauri-plugin-wdio-webdriver";
const VERSION = "1.2.0";
const UPSTREAM_CHECKSUM = "30c5bffe978c41b06ad44a5f4b5b543405918cf316b98756c678a6431061f2e9";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function nativeWebdriverOption(arguments_, platform = process.platform) {
  const positions = arguments_.flatMap((value, index) =>
    value === "--native-webdriver-source" ? [index] : [],
  );
  requireValue(positions.length <= 1, "--native-webdriver-source may be supplied only once");
  if (positions.length === 0) return undefined;
  const value = arguments_[positions[0] + 1];
  requireValue(
    typeof value === "string" && value.length > 0 && !value.startsWith("--"),
    "--native-webdriver-source requires a path",
  );
  requireValue(platform === "darwin", "--native-webdriver-source is supported only on macOS");
  return value;
}

function manifestRows(manifest, label) {
  requireValue(
    Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= MAX_FILES,
    `${label} must contain a bounded file inventory`,
  );
  const rows = new Map();
  for (const row of manifest.files) {
    requireValue(
      typeof row.path === "string" &&
        !path.posix.isAbsolute(row.path) &&
        !row.path.includes("\\") &&
        !row.path.includes("\0") &&
        row.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `${label} contains an unsafe file path`,
    );
    requireValue(!rows.has(row.path), `${label} contains a duplicate file path`);
    requireValue(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        row.bytes <= MAX_FILE_BYTES &&
        typeof row.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(row.sha256),
      `${label} contains an invalid file identity`,
    );
    rows.set(row.path, { path: row.path, bytes: row.bytes, sha256: row.sha256 });
  }
  return rows;
}

async function hashBoundedFile(filename, keepContent = false) {
  const info = await lstat(filename);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE_BYTES,
    `native provider file is not a bounded regular file: ${filename}`,
  );
  let bytes = 0;
  const chunks = [];
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    requireValue(
      bytes <= MAX_FILE_BYTES,
      `native provider file grew beyond its limit: ${filename}`,
    );
    hash.update(chunk);
    if (keepContent) chunks.push(chunk);
  }
  requireValue(bytes === info.size, `native provider file changed while reading: ${filename}`);
  return {
    bytes,
    sha256: hash.digest("hex"),
    ...(keepContent ? { content: Buffer.concat(chunks) } : {}),
  };
}

async function collectFiles(root) {
  const files = [];
  let entryCount = 0;
  async function visit(directory, prefix, depth = 0) {
    requireValue(depth <= 16, "native provider directory nesting is too deep");
    for (const name of (await readdir(directory)).sort()) {
      entryCount += 1;
      requireValue(entryCount <= 1024, "native provider contains too many directory entries");
      const filename = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(filename);
      requireValue(
        !info.isSymbolicLink(),
        `native provider must not contain symlinks: ${relative}`,
      );
      if (info.isDirectory()) await visit(filename, relative, depth + 1);
      else {
        requireValue(info.isFile(), `native provider contains a non-regular input: ${relative}`);
        files.push(relative);
        requireValue(files.length <= MAX_FILES, "native provider has too many files");
      }
    }
  }
  await visit(root, "");
  return files.sort();
}

async function readManifest(filename) {
  const { content, ...identity } = await hashBoundedFile(filename, true);
  return { identity, manifest: JSON.parse(content.toString("utf8")) };
}

/** Validate only. This helper never materializes sources, invokes Cargo, or modifies a registry. */
export async function validateNativeWebdriverSource(
  source,
  { manifestDirectory, platform = process.platform } = {},
) {
  requireValue(platform === "darwin", "native WebDriver override is supported only on macOS");
  requireValue(
    typeof source === "string" && path.isAbsolute(source),
    "native WebDriver source must be an absolute path",
  );
  requireValue(
    typeof manifestDirectory === "string" && path.isAbsolute(manifestDirectory),
    "native WebDriver trusted manifest directory must be absolute",
  );
  const sourceInfo = await lstat(source);
  requireValue(
    sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(),
    "native WebDriver source must be a real directory, not a symlink",
  );
  const sourceRoot = await realpath(source);
  const original = await readManifest(path.join(manifestDirectory, "original-inventory.json"));
  const overlay = await readManifest(path.join(manifestDirectory, "overlay-manifest.json"));
  requireValue(
    original.manifest.package === PACKAGE &&
      original.manifest.version === VERSION &&
      original.manifest.registryChecksum === UPSTREAM_CHECKSUM,
    "native WebDriver upstream identity is not the fixed 1.2.0 provider",
  );
  requireValue(
    overlay.manifest.schemaVersion === 1 &&
      overlay.manifest.upstreamPackage === PACKAGE &&
      overlay.manifest.upstreamVersion === VERSION,
    "native WebDriver overlay identity does not match the fixed provider",
  );
  const expected = manifestRows(original.manifest, "upstream inventory");
  for (const [name, row] of manifestRows(overlay.manifest, "native overlay"))
    expected.set(name, row);
  const files = await collectFiles(sourceRoot);
  requireValue(
    files.length === expected.size && files.every((name) => expected.has(name)),
    "native WebDriver materialized inventory has missing or unexpected files",
  );
  let totalBytes = 0;
  const observed = [];
  for (const name of files) {
    const actual = await hashBoundedFile(path.join(sourceRoot, name));
    totalBytes += actual.bytes;
    requireValue(
      totalBytes <= MAX_TOTAL_BYTES,
      "native WebDriver source exceeds its total byte limit",
    );
    const wanted = expected.get(name);
    requireValue(
      actual.bytes === wanted.bytes && actual.sha256 === wanted.sha256,
      `native WebDriver source identity mismatch: ${name}`,
    );
    observed.push({ path: name, ...actual });
  }
  const cargoFile = await hashBoundedFile(path.join(sourceRoot, "Cargo.toml"), true);
  requireValue(
    cargoFile.bytes === expected.get("Cargo.toml")?.bytes &&
      cargoFile.sha256 === expected.get("Cargo.toml")?.sha256,
    "native provider Cargo manifest changed while reading",
  );
  const cargo = cargoFile.content.toString("utf8");
  const packageSection = cargo.split(/^\[package\]\r?\n/m)[1]?.split(/^\[/m)[0];
  requireValue(
    packageSection &&
      /^name = "tauri-plugin-wdio-webdriver"\r?$/m.test(packageSection) &&
      /^version = "1\.2\.0"\r?$/m.test(packageSection),
    "native provider Cargo package must be tauri-plugin-wdio-webdriver 1.2.0",
  );
  return {
    cargoArguments: [
      "--",
      "--config",
      `patch.crates-io.tauri-plugin-wdio-webdriver.path=${JSON.stringify(sourceRoot)}`,
    ],
    provenance: {
      type: "tauri-native-webdriver-source",
      package: PACKAGE,
      version: VERSION,
      source: sourceRoot,
      upstreamChecksum: UPSTREAM_CHECKSUM,
      originalInventorySha256: original.identity.sha256,
      overlayManifestSha256: overlay.identity.sha256,
      materializedInventorySha256: sha256(JSON.stringify(observed)),
      fileCount: observed.length,
      bytes: totalBytes,
    },
  };
}
