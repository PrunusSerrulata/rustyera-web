// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Cache contracts query tool identities only. Never start git, rustc or Cargo in these tests.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: Object.assign(
    () => {
      throw new Error("unexpected non-promisified tool execution");
    },
    {
      [Symbol.for("nodejs.util.promisify.custom")]: async (_command, args, options) => ({
        stdout:
          args[0] === "ls-files"
            ? options.cwd.endsWith("rustyera-web")
              ? "scripts/tauri-performance-timing-evidence.mjs\0src-tauri/src/native_host.rs\0Cargo.lock\0"
              : "tools/sqlite-native/build.mjs\0"
            : "fake tool identity",
        stderr: "",
      }),
    },
  ),
}));

import {
  buildContract,
  recordBuiltArtifact,
  reusableArtifact,
} from "../scripts/tauri-build-cache.mjs";
import { cargoCommandIdentity } from "../scripts/cargo-command-identity.mjs";
import { vmProfileBuildFeature } from "../scripts/tauri-performance-vm-profile.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture({ prebuild = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "native-sqlite-script-"));
  roots.push(root);
  const repository = path.join(root, "rustyera-web");
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await mkdir(path.join(repository, "public"));
  await mkdir(path.join(repository, "src-tauri/src"), { recursive: true });
  await writeFile(path.join(repository, "src-tauri/src/native_host.rs"), "// native host v1\n");
  await writeFile(
    path.join(repository, "scripts/tauri-performance-timing-evidence.mjs"),
    "// collector v1\n",
  );
  // The fake executable is Node, whose script argument is not a Cargo argument.
  await writeFile(
    path.join(repository, "scripts/cargo-local.mjs"),
    (await readFile(path.resolve("scripts/cargo-local.mjs"), "utf8")).replace(
      "cargoCommandIdentity(args, process.env, cargo)",
      "cargoCommandIdentity(args.slice(1), process.env, cargo)",
    ),
  );
  await copyFile(
    path.resolve("scripts/cargo-command-identity.mjs"),
    path.join(repository, "scripts/cargo-command-identity.mjs"),
  );
  await copyFile(
    path.resolve("scripts/tauri-build-cache.mjs"),
    path.join(repository, "scripts/tauri-build-cache.mjs"),
  );
  await writeFile(path.join(repository, "Cargo.lock"), "original lock\n");
  const child = path.join(repository, "child.mjs");
  await writeFile(
    child,
    `import { writeFileSync } from "node:fs";
writeFileSync("child-env.json", JSON.stringify(process.env));
writeFileSync("Cargo.lock", "child changed lock");
`,
  );
  if (prebuild) {
    const directory = path.join(root, "rustyera-core/tools/sqlite-native");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "build.mjs"),
      `import { appendFileSync } from "node:fs";
export async function prepareNativeSqlite(options) {
  appendFileSync(options.environment.CALLS, JSON.stringify(options) + "\\n");
  if (options.environment.MISS === "1") throw new Error("SQLite static cache missing; no compilation started");
  return { environment: { SQLITE3_LIB_DIR: "/fake/verified", SQLITE3_INCLUDE_DIR: "/fake/verified", SQLITE3_STATIC: "1", SQLITE3_NO_PKG_CONFIG: "1" }, inputs: { target: options.target || options.environment.CARGO_BUILD_TARGET || "aarch64-apple-darwin", sourceManifest: { sqliteVersion: "3.53.4" }, files: { "sqlite3.c": "source-digest" }, flags: ["-DSQLITE_THREADSAFE=1"], tuning: options.environment.RUSTYERA_SQLITE_CFLAGS_JSON || "[]" }, artifacts: { "libsqlite3.a": { sha256: "fake-digest", bytes: 123 }, "sqlite3.h": { sha256: "header-digest", bytes: 45 } } };
}
`,
    );
  }
  return { root, repository, child, calls: path.join(root, "calls.jsonl") };
}

function environment(files, extra = {}) {
  const result = { ...process.env };
  delete result.CARGO_BUILD_TARGET;
  for (const name of Object.keys(result))
    if (
      /^(SQLITE3_|LIBSQLITE3_|RUSTYERA_SQLITE_)/.test(name) ||
      name === "RUSTYERA_NATIVE_SQL_PROVIDER"
    )
      delete result[name];
  return { ...result, RUSTYERA_CARGO: process.execPath, CALLS: files.calls, ...extra };
}

function run(files, args, extra = {}) {
  return spawnSync(
    process.execPath,
    [path.join(files.repository, "scripts/cargo-local.mjs"), files.child, ...args],
    {
      env: environment(files, extra),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

async function contract(files, args, extra = {}) {
  return buildContract({
    repository: files.repository,
    binary: "fake-binary",
    args,
    environment: environment(files, extra),
  });
}

describe("native SQL launcher feature and legacy environment opt-in", () => {
  it.each(
    [
      ["--features", "native-sql"],
      ["--features=webdriver,native-sql"],
      ["--features", "webdriver native-sql"],
      ["-F", "era-web-tauri/native-sql"],
      ["-Fnative-sql"],
      ["--features=webdriver", "--features=native-sql"],
      ["--all-features"],
    ].map((args) => [args]),
  )("prebuilds from Cargo feature arguments %j without an extra switch", async (features) => {
    const files = await fixture({ prebuild: true });
    const args = ["build", "-p", "era-web-tauri", ...features, "--target", "aarch64-apple-darwin"];
    const result = run(files, args, { RUSTYERA_NATIVE_SQL_PROVIDER: "0" });
    expect(result.status, result.stderr).toBe(0);
    const calls = (await readFile(files.calls, "utf8")).trim().split("\n").map(JSON.parse);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: "aarch64-apple-darwin", cacheOnly: false });
    const childEnv = JSON.parse(
      await readFile(path.join(files.repository, "child-env.json"), "utf8"),
    );
    expect(childEnv.SQLITE3_LIB_DIR).toBe("/fake/verified");
    const cached = await contract(files, args);
    expect(cached.inputs.nativeSqlite).toMatchObject({
      inputs: {
        target: "aarch64-apple-darwin",
        sourceManifest: { sqliteVersion: "3.53.4" },
        files: { "sqlite3.c": "source-digest" },
        flags: ["-DSQLITE_THREADSAFE=1"],
      },
      artifacts: {
        "libsqlite3.a": { sha256: "fake-digest" },
        "sqlite3.h": { sha256: "header-digest" },
      },
    });
  });

  it.each(
    [
      ["build", "--features=not-native-sql"],
      ["run", "--", "--features=native-sql"],
      ["metadata", "--features=native-sql"],
      ["fmt", "--all-features"],
      ["metadata", "--features=native-sql", "--config", "build"],
    ].map((args) => [args]),
  )("does not prebuild for unrelated features or non-build commands %j", async (args) => {
    const files = await fixture();
    const result = run(files, args);
    expect(result.status, result.stderr).toBe(0);
    expect((await contract(files, args)).inputs).not.toHaveProperty("nativeSqlite");
  });

  it("keeps feature-triggered misses cache-only and preserves the inherited target", async () => {
    const files = await fixture({ prebuild: true });
    const extra = {
      CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu",
      RUSTYERA_SQLITE_NATIVE_CACHE_ONLY: "1",
      MISS: "1",
    };
    const args = ["build", "--features=native-sql"];
    const result = run(files, args, extra);
    expect(result.status).not.toBe(0);
    await expect(contract(files, args, extra)).rejects.toThrow("no compilation started");
    const calls = (await readFile(files.calls, "utf8")).trim().split("\n").map(JSON.parse);
    for (const call of calls)
      expect(call).toMatchObject({
        cacheOnly: true,
        environment: { CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu" },
      });
    await expect(readFile(path.join(files.repository, "child-env.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(files.repository, "Cargo.lock"), "utf8")).resolves.toBe(
      "original lock\n",
    );
  });

  it("rejects reuse when native features toggle even with the legacy switch unchanged", async () => {
    const files = await fixture({ prebuild: true });
    const extra = { RUSTYERA_NATIVE_SQL_PROVIDER: "1" };
    const disabled = await contract(files, ["build"], extra);
    const enabled = await contract(files, ["build", "--features=native-sql"], extra);
    const binary = path.join(files.repository, "fake-binary");
    const manifest = `${binary}.json`;
    await writeFile(binary, "same binary");
    await recordBuiltArtifact(manifest, disabled, binary);
    await expect(reusableArtifact(manifest, enabled, binary, { required: true })).rejects.toThrow(
      "featureIdentity",
    );
    await recordBuiltArtifact(manifest, enabled, binary);
    await expect(reusableArtifact(manifest, disabled, binary, { required: true })).rejects.toThrow(
      "featureIdentity",
    );
    const tuned = await contract(files, ["build", "--features=native-sql"], {
      ...extra,
      RUSTYERA_SQLITE_CFLAGS_JSON: '["-mcpu=apple-m1"]',
    });
    expect(tuned.sha256).not.toBe(enabled.sha256);
  });

  it("reuses collector-only changes while retaining the collector evidence identity", async () => {
    const files = await fixture({ prebuild: true });
    const args = ["build", "--features=native-sql"];
    const before = await contract(files, args);
    const binary = path.join(files.repository, "fake-binary");
    const manifest = `${binary}.json`;
    await writeFile(binary, "same binary");
    await recordBuiltArtifact(manifest, before, binary);
    const collector = "scripts/tauri-performance-timing-evidence.mjs";
    await writeFile(path.join(files.repository, collector), "// collector v2\n");
    const after = await contract(files, args);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.inputs.webSources.find(([name]) => name === collector)).not.toEqual(
      before.inputs.webSources.find(([name]) => name === collector),
    );
    await expect(
      reusableArtifact(manifest, after, binary, { required: true }),
    ).resolves.toBeDefined();

    await writeFile(
      path.join(files.repository, "src-tauri/src/native_host.rs"),
      "// native host v2\n",
    );
    await expect(
      reusableArtifact(manifest, await contract(files, args), binary, { required: true }),
    ).rejects.toThrow("webSources");
  });

  it.each(["archive", "header", "source", "lock", "environment", "feature"])(
    "retains %s invalidation alongside collector exclusion",
    async (input) => {
      const files = await fixture({ prebuild: true });
      const before = await contract(files, ["build", "--features=native-sql"]);
      const binary = path.join(files.repository, "fake-binary");
      const manifest = `${binary}.json`;
      await writeFile(binary, "same binary");
      await recordBuiltArtifact(manifest, before, binary);
      const inputs = structuredClone(before.inputs);
      const collector = inputs.webSources.find(
        ([name]) => name === "scripts/tauri-performance-timing-evidence.mjs",
      );
      collector[1].sha256 = "changed collector";
      if (input === "archive")
        inputs.nativeSqlite.artifacts["libsqlite3.a"].sha256 = "changed archive";
      if (input === "header") inputs.nativeSqlite.artifacts["sqlite3.h"].sha256 = "changed header";
      if (input === "source") inputs.nativeSqlite.inputs.files["sqlite3.c"] = "changed source";
      if (input === "lock")
        inputs.webSources.find(([name]) => name === "Cargo.lock")[1].sha256 = "changed lock";
      if (input === "environment") inputs.environment.RUSTFLAGS = "changed flags";
      if (input === "feature") inputs.featureIdentity.features.push("performance-audit");
      const field = ["archive", "header", "source"].includes(input)
        ? "nativeSqlite"
        : input === "lock"
          ? "webSources"
          : input === "feature"
            ? "featureIdentity"
            : "environment.RUSTFLAGS";
      await expect(
        reusableArtifact(manifest, { inputs, sha256: "changed contract" }, binary, {
          required: true,
        }),
      ).rejects.toThrow(field);
    },
  );

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "adds the runner opt-in to actual nested Cargo features (performance=%s, sampling=%s)",
    async (instrumentPerformance, vmInstructionProfile) => {
      const source = await readFile(path.resolve("scripts/tauri-test.mjs"), "utf8");
      const expression = source.match(/"--features",\s*([\s\S]*?),\s*"--config"/)[1];
      const selectFeatures = new Function(
        "instrumentPerformance",
        "buildEnvironment",
        "vmInstructionProfile",
        "vmProfileBuildFeature",
        `return (${expression});`,
      );
      const files = await fixture({ prebuild: true });
      for (const enabled of [undefined, "0", "1"]) {
        const extra = enabled === undefined ? {} : { RUSTYERA_NATIVE_SQL_PROVIDER: enabled };
        const featureList = selectFeatures(
          instrumentPerformance,
          extra,
          vmInstructionProfile,
          vmProfileBuildFeature,
        );
        expect(featureList).toBe(
          (instrumentPerformance ? "webdriver,performance-audit" : "webdriver") +
            (enabled === "1" ? ",native-sql" : "") +
            (vmInstructionProfile ? ",vm-instruction-profile" : ""),
        );
        const args = ["run", "tauri", "--", "build", "--features", featureList];
        const cached = await contract(files, args, extra);
        expect(cached.inputs.featureIdentity.features.includes("native-sql")).toBe(enabled === "1");
        expect(cached.inputs.featureIdentity.features.includes("vm-instruction-profile")).toBe(
          vmInstructionProfile,
        );
        expect(Boolean(cached.inputs.nativeSqlite)).toBe(enabled === "1");
        const result = run(files, args, extra);
        expect(result.status, result.stderr).toBe(0);
      }
    },
  );

  it.each([undefined, "0"])(
    "keeps native builds independent of prebuild when enable=%s",
    async (enabled) => {
      const files = await fixture();
      const extra = enabled === undefined ? {} : { RUSTYERA_NATIVE_SQL_PROVIDER: enabled };
      const result = run(files, ["build", "--target=x86_64-pc-windows-msvc"], extra);
      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(path.join(files.repository, "Cargo.lock"), "utf8")).resolves.toBe(
        "original lock\n",
      );
      const cached = await contract(files, ["build"], extra);
      expect(cached.inputs).not.toHaveProperty("nativeSqlite");
      expect(cached.inputs.coreSources).toEqual([]);
    },
  );

  it("prepares only explicitly enabled native builds and passes verified link variables", async () => {
    const files = await fixture({ prebuild: true });
    const result = run(files, ["build", "--target=aarch64-apple-darwin"], {
      RUSTYERA_NATIVE_SQL_PROVIDER: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = (await readFile(files.calls, "utf8")).trim().split("\n").map(JSON.parse);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: "aarch64-apple-darwin", cacheOnly: false });
    const childEnv = JSON.parse(
      await readFile(path.join(files.repository, "child-env.json"), "utf8"),
    );
    expect(childEnv).toMatchObject({
      SQLITE3_LIB_DIR: "/fake/verified",
      SQLITE3_STATIC: "1",
      SQLITE3_NO_PKG_CONFIG: "1",
    });
    await expect(readFile(path.join(files.repository, "Cargo.lock"), "utf8")).resolves.toBe(
      "original lock\n",
    );
    const cached = await contract(files, ["build"], { RUSTYERA_NATIVE_SQL_PROVIDER: "1" });
    expect(cached.inputs.nativeSqlite.artifacts["libsqlite3.a"].sha256).toBe("fake-digest");
    expect(
      JSON.parse((await readFile(files.calls, "utf8")).trim().split("\n").at(-1)).cacheOnly,
    ).toBe(true);
  });

  it("stops cache-only misses before the child or lockfile mutation", async () => {
    const files = await fixture({ prebuild: true });
    const extra = {
      RUSTYERA_NATIVE_SQL_PROVIDER: "1",
      RUSTYERA_SQLITE_NATIVE_CACHE_ONLY: "1",
      MISS: "1",
    };
    const result = run(files, ["build"], extra);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no compilation started");
    await expect(readFile(path.join(files.repository, "child-env.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(files.repository, "Cargo.lock"), "utf8")).resolves.toBe(
      "original lock\n",
    );
    await expect(contract(files, ["build"], extra)).rejects.toThrow("no compilation started");
    for (const call of (await readFile(files.calls, "utf8")).trim().split("\n").map(JSON.parse))
      expect(call.cacheOnly).toBe(true);
  });

  it.each(
    [
      ["build", "--target=wasm32-unknown-unknown"],
      ["build", "--target", "wasm32-unknown-unknown"],
      ["build", "-p", "era-web-wasm"],
      ["build", "--package", "era-web-wasm"],
      ["build", "--package=era-web-wasm"],
      ["build", "-pera-web-wasm"],
      ["build", "--manifest-path", "crates/era-web-wasm/Cargo.toml"],
      ["build", "--manifest-path=crates/era-web-wasm/Cargo.toml"],
      ["run", "tauri", "--", "build", "--target=wasm32-unknown-unknown"],
      ["npm", "run", "tauri", "--", "build", "--target", "wasm32-unknown-unknown"],
    ].map((args) => [args]),
  )("clears inherited native SQL configuration for WASM %j", async (args) => {
    const files = await fixture();
    const extra = {
      RUSTYERA_NATIVE_SQL_PROVIDER: "1",
      SQLITE3_LIB_DIR: "/wrong",
      LIBSQLITE3_SYS_USE_PKG_CONFIG: "1",
      RUSTYERA_SQLITE_NATIVE_CACHE_ONLY: "1",
    };
    const featureArgs = [...args, "--features=native-sql"];
    const result = run(files, featureArgs, extra);
    expect(result.status, result.stderr).toBe(0);
    const childEnv = JSON.parse(
      await readFile(path.join(files.repository, "child-env.json"), "utf8"),
    );
    for (const name of Object.keys(extra)) expect(childEnv).not.toHaveProperty(name);
    expect((await contract(files, featureArgs, extra)).inputs).not.toHaveProperty("nativeSqlite");
  });

  it.each(
    [
      ["run", "--features", "native-sql", "--", "--target=wasm32-unknown-unknown"],
      ["run", "--features=native-sql", "--", "--target", "wasm32-unknown-unknown"],
      ["run", "--features=native-sql", "--", "--package=era-web-wasm"],
      ["run", "--features=native-sql", "--", "-p", "era-web-wasm", "--all-features"],
      ["run", "--features=native-sql", "--", "--manifest-path=crates/era-web-wasm/Cargo.toml"],
      ["run", "--features=native-sql", "--", "--features=era-web-wasm"],
      ["build", "--features=native-sql", "--config", "era-web-wasm"],
      ["build", "--features=native-sql", "--config=era-web-wasm"],
      ["build", "--features=native-sql,era-web-wasm"],
      ["build", "--features=native-sql", "--package=unrelated-era-web-wasm"],
      ["build", "--features=native-sql", "--manifest-path=crates/era-web-wasm-other/Cargo.toml"],
      ["build", "--features=native-sql", "--target=web"],
      [
        "run",
        "tauri",
        "--",
        "build",
        "--features=native-sql",
        "--",
        "--target=wasm32-unknown-unknown",
        "--package=era-web-wasm",
      ],
      [
        "npm",
        "run",
        "tauri",
        "--",
        "build",
        "--features=native-sql",
        "--target=aarch64-apple-darwin",
      ],
      ["run", "tauri", "--", "build", "--features=native-sql", "--target", "aarch64-apple-darwin"],
    ].map((args) => [args]),
  )("keeps launcher and cache native identity aligned for %j", async (args) => {
    const files = await fixture({ prebuild: true });
    const result = run(files, args);
    expect(result.status, result.stderr).toBe(0);
    const childEnv = JSON.parse(
      await readFile(path.join(files.repository, "child-env.json"), "utf8"),
    );
    expect(childEnv.SQLITE3_LIB_DIR).toBe("/fake/verified");
    const cached = await contract(files, args);
    expect(cached.inputs).toHaveProperty("nativeSqlite");
    const calls = (await readFile(files.calls, "utf8")).trim().split("\n").map(JSON.parse);
    expect(calls).toHaveLength(2);
    expect(calls[0].target).toBe(calls[1].target);
    expect(cached.inputs.featureIdentity).toEqual(cargoCommandIdentity(args).featureIdentity);
  });

  it("ignores every identity-looking application argument after the Cargo separator", async () => {
    const args = [
      "run",
      "--",
      "--target",
      "wasm32-unknown-unknown",
      "--package",
      "era-web-wasm",
      "--features",
      "native-sql",
      "--all-features",
      "--no-default-features",
    ];
    expect(cargoCommandIdentity(args)).toMatchObject({
      command: "run",
      target: undefined,
      packages: [],
      manifestPaths: [],
      wasmBuild: false,
      featureIdentity: { features: [], allFeatures: false, noDefaultFeatures: false },
    });
    const files = await fixture();
    const result = run(files, args, { SQLITE3_LIB_DIR: "/inherited" });
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(files.repository, "child-env.json"), "utf8")),
    ).toHaveProperty("SQLITE3_LIB_DIR", "/inherited");
    expect((await contract(files, args)).inputs).not.toHaveProperty("nativeSqlite");
  });

  it("recognizes wasm-pack independently of packaging target", async () => {
    const files = await fixture();
    // Node executes this source as its first argument. This tests the actual launcher
    // detection without making a platform-specific executable or launching wasm-pack.
    const wrapper = path.join(files.repository, "scripts/cargo-local.mjs");
    const source = await readFile(wrapper, "utf8");
    await writeFile(
      wrapper,
      source
        .replace(
          'const cargo = process.env.RUSTYERA_CARGO || "cargo";',
          'const cargo = "/fake/wasm-pack";',
        )
        .replace("spawn(cargo, args,", "spawn(process.execPath, args,"),
    );
    const result = run(files, ["build"], { RUSTYERA_NATIVE_SQL_PROVIDER: "1" });
    expect(result.status, result.stderr).toBe(0);
    const childEnv = JSON.parse(
      await readFile(path.join(files.repository, "child-env.json"), "utf8"),
    );
    expect(childEnv).not.toHaveProperty("RUSTYERA_NATIVE_SQL_PROVIDER");
    expect(
      (
        await contract(files, ["build"], {
          RUSTYERA_CARGO: "/fake/wasm-pack",
          RUSTYERA_NATIVE_SQL_PROVIDER: "1",
        })
      ).inputs,
    ).not.toHaveProperty("nativeSqlite");
  });
});
