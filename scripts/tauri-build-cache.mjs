import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, release as osRelease } from "node:os";
import path from "node:path";

const execute = promisify(execFile);
const reusableSpecs = new Set([
  "project-load-failure.spec.mjs",
  "native-input.spec.mjs",
  "cache-settings.spec.mjs",
  "snake-service-oracle.spec.mjs",
  "snake-service-lifecycle.spec.mjs",
  "snake-services.spec.mjs",
  "snake-batch1.spec.mjs",
  "snake-data.spec.mjs",
  "snake-sql.spec.mjs",
  "snake-audio.spec.mjs",
  "snake-interop.spec.mjs",
  "snake-ingestion.spec.mjs",
  "snake-profile.spec.mjs",
  "snake-save-menu.spec.mjs",
  "full-project-export.spec.mjs",
]);

// These specs choose directories through the existing test-only picker configuration.
// No fixture paths or per-spec flags need to be embedded in the reusable executable.
export function reusableBuildEnvironment(environment, specName, state, enabled) {
  if (!enabled) return { ...environment };
  if (!reusableSpecs.has(specName) || state)
    throw new Error("--reuse-build requires a supported snake/native-input spec without --state");
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (name.startsWith("VITE_RUSTYERA_TAURI_")) delete result[name];
  }
  return {
    ...result,
    VITE_RUSTYERA_TEST: "1",
    VITE_RUSTYERA_TAURI_TEST: "1",
    VITE_RUSTYERA_TEST_PROJECT: "/__rustyera_test_picker_must_be_configured__",
    VITE_RUSTYERA_TEST_PROJECT_FILE: "",
    VITE_RUSTYERA_TEST_STATE: "",
    VITE_RUSTYERA_TEST_STATE_TYPE: "",
  };
}

export async function fileIdentity(filename) {
  try {
    const before = await lstat(filename);
    if (!before.isFile()) throw new Error(`build input is not a regular file: ${filename}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await lstat(filename);
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(`build input changed while hashing: ${filename}`);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function sourceIdentity(root, core = false) {
  const { stdout } = await execute("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  const files = [...new Set(stdout.split("\0").filter(Boolean))].filter((name) =>
    core
      ? /^(crates\/|Cargo\.|rust-toolchain)/.test(name)
      : !name.includes("/") || /^(src\/|src-tauri\/|crates\/|scripts\/|public\/)/.test(name),
  );
  const identities = [];
  for (const name of files.sort())
    identities.push([name, await fileIdentity(path.join(root, name))]);
  return identities;
}

async function publicAssets(directory) {
  const rows = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await publicAssets(filename)));
    else rows.push([filename, await fileIdentity(filename)]);
  }
  return rows;
}

export async function buildContract({ repository, binary, args, environment, provider }) {
  const configs = new Set();
  for (let directory = repository; ; directory = path.dirname(directory)) {
    configs.add(path.join(directory, ".cargo/config"));
    configs.add(path.join(directory, ".cargo/config.toml"));
    if (directory === path.dirname(directory)) break;
  }
  const cargoHome = environment.CARGO_HOME || path.join(homedir(), ".cargo");
  configs.add(path.join(cargoHome, "config"));
  configs.add(path.join(cargoHome, "config.toml"));
  for (const name of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    "node_modules/.package-lock.json",
  ])
    configs.add(path.join(repository, name));
  // Both the publish pin and the actual patched source are inputs. Build scripts and
  // shared core crates must invalidate the executable even with an unchanged pin.
  const core = path.resolve(repository, "../rustyera-core");
  const [webSources, coreSources, compiler, cargo] = await Promise.all([
    sourceIdentity(repository),
    sourceIdentity(core, true),
    execute("rustc", ["-vV"], { cwd: repository, env: environment }),
    execute("cargo", ["-V"], { cwd: repository, env: environment }),
  ]);
  const inputs = {
    schemaVersion: 1,
    repository,
    binary,
    args,
    provider: provider ?? null,
    platform: [process.platform, process.arch, osRelease(), process.version, process.execPath],
    compiler: compiler.stdout,
    cargo: cargo.stdout,
    environment: Object.fromEntries(
      Object.entries(environment)
        .filter(
          ([name]) =>
            /^(CARGO|RUST|VITE_|TAURI_|CC$|CXX$|CFLAGS$|CXXFLAGS$|LDFLAGS$|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|PATH$)/.test(
              name,
            ) && !name.startsWith("RUSTYERA_"),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    files: await Promise.all(
      [...configs].sort().map(async (name) => [name, await fileIdentity(name)]),
    ),
    webSources,
    coreSources,
    publicAssets: await publicAssets(path.join(repository, "public")),
  };
  return { inputs, sha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex") };
}

// Node-only runner files are not embedded by Vite or Cargo; effective build
// arguments, environment, provider and all product inputs remain in the contract.
export function compiledBuildInputs(inputs) {
  return (
    inputs && {
      ...inputs,
      webSources: inputs.webSources?.filter(
        ([name]) =>
          ![
            "scripts/tauri-test.mjs",
            "scripts/tauri-test-support.mjs",
            "scripts/tauri-build-cache.mjs",
            "scripts/snake-service-lifecycle-test-support.mjs",
            "scripts/snake-service-lifecycle-races.mjs",
            "scripts/snake-services-test-support.mjs",
            "scripts/browser-compat-test.mjs",
            "scripts/cache-handoff-test.mjs",
            "scripts/prepare-snake-audio-fixture.mjs",
            "scripts/web-test-lib.mjs",
            "scripts/web-test-lib.d.mts",
            "scripts/web-test.mjs",
            "scripts/project-load-failure.mjs",
            "scripts/project-export-cancel.mjs",
            "scripts/dom-test-input.mjs",
            "scripts/web-test-runtime.mjs",
          ].includes(name),
      ),
    }
  );
}

export async function reusableArtifact(manifestPath, contract, binary, { required = false } = {}) {
  const miss = (reason) => {
    if (required) throw new Error(`Tauri cached build required: ${reason}; no build was started`);
    return undefined;
  };
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError)
      return miss("manifest missing or invalid");
    throw error;
  }
  if (manifest?.schemaVersion !== 1) return miss("manifest schema mismatch");
  if (manifest.contract?.sha256 !== contract.sha256) {
    if (
      !manifest.contract?.inputs ||
      !contract.inputs ||
      JSON.stringify(compiledBuildInputs(manifest.contract.inputs)) !==
        JSON.stringify(compiledBuildInputs(contract.inputs))
    ) {
      const previous = compiledBuildInputs(manifest.contract?.inputs);
      const current = compiledBuildInputs(contract.inputs);
      const changed = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})])]
        .filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(current?.[key]))
        .flatMap((key) =>
          key === "environment"
            ? [
                ...new Set([
                  ...Object.keys(previous?.environment ?? {}),
                  ...Object.keys(current?.environment ?? {}),
                ]),
              ]
                .filter((name) => previous?.environment?.[name] !== current?.environment?.[name])
                .map((name) => `environment.${name}`)
            : [key],
        );
      return miss(`build contract changed (${changed.join(", ") || "missing inputs"})`);
    }
  }
  const actual = await fileIdentity(binary);
  return actual && JSON.stringify(actual) === JSON.stringify(manifest.binary)
    ? manifest
    : miss("executable missing or hash mismatch");
}

export async function recordBuiltArtifact(manifestPath, contract, binary) {
  const identity = await fileIdentity(binary);
  if (!identity) throw new Error("successful Tauri build did not produce its executable");
  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    contract,
    binary: identity,
  };
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  await rename(temporary, manifestPath);
  return manifest;
}
