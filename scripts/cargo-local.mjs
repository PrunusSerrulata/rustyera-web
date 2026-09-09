import { spawn } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cargoCommandIdentity, nativeSqlFeatureEnabled } from "./cargo-command-identity.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = resolve(workspace, "Cargo.lock");
const state = resolve(workspace, ".rustyera", "cargo-local");
const backup = resolve(state, "Cargo.lock.remote");
const owner = resolve(state, "owner.json");
const cargo = process.env.RUSTYERA_CARGO || "cargo";
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("用法: npm run cargo:local -- <cargo 参数>");
  process.exit(2);
}

// wasm-pack's --target names a JS packaging mode, not a Rust target. Never pass
// native library locations to that build, even when inherited from a Tauri shell.
const identity = cargoCommandIdentity(args, process.env, cargo);
const { target: targetArgument, wasmBuild } = identity;
const environment = { ...process.env };
if (wasmBuild) {
  for (const name of Object.keys(environment))
    if (
      name.startsWith("SQLITE3_") ||
      name.startsWith("LIBSQLITE3_") ||
      name.startsWith("RUSTYERA_SQLITE_") ||
      name === "RUSTYERA_NATIVE_SQL_PROVIDER"
    )
      delete environment[name];
} else if (
  (nativeSqlFeatureEnabled(identity.featureIdentity) ||
    environment.RUSTYERA_NATIVE_SQL_PROVIDER === "1") &&
  identity.buildsNative
) {
  const { prepareNativeSqlite } = await import(
    pathToFileURL(resolve(workspace, "../rustyera-core/tools/sqlite-native/build.mjs")).href
  );
  const sqlite = await prepareNativeSqlite({
    target: targetArgument,
    environment,
    cacheOnly: environment.RUSTYERA_SQLITE_NATIVE_CACHE_ONLY === "1",
  });
  // libsqlite3-sys reads these before the parent crate's build script can run.
  Object.assign(environment, sqlite.environment);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function restoreLockfile() {
  if (!existsSync(backup)) return;
  const temporary = `${lockfile}.cargo-local-${process.pid}`;
  copyFileSync(backup, temporary);
  renameSync(temporary, lockfile);
}

function recoverStaleState() {
  if (!existsSync(state)) return;
  let pid;
  try {
    pid = JSON.parse(readFileSync(owner, "utf8")).pid;
  } catch {
    // An incomplete state directory is stale and safe to recover.
  }
  if (Number.isInteger(pid) && processIsAlive(pid)) {
    throw new Error(`另一个本地 Cargo 命令正在运行（PID ${pid}）`);
  }
  if (!Number.isInteger(pid) && Date.now() - statSync(state).mtimeMs < 5000) {
    throw new Error("另一个本地 Cargo 命令正在初始化");
  }
  restoreLockfile();
  rmSync(state, { recursive: true, force: true });
  console.warn("已从异常中断的本地 Cargo 命令恢复 Cargo.lock");
}

recoverStaleState();
mkdirSync(dirname(state), { recursive: true });
mkdirSync(state);
copyFileSync(lockfile, backup);
writeFileSync(owner, `${JSON.stringify({ pid: process.pid })}\n`, { flag: "wx" });
const originalMode = statSync(lockfile).mode;

let child;
let requestedSignal;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    requestedSignal ??= signal;
    child?.kill(signal);
  });
}

try {
  child = spawn(cargo, args, { cwd: workspace, env: environment, stdio: "inherit" });
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ error }));
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.error) {
    console.error(`无法启动 ${cargo}：${result.error.message}`);
    process.exitCode = 127;
  } else if (requestedSignal || result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.code ?? 1;
  }
} finally {
  restoreLockfile();
  chmodSync(lockfile, originalMode);
  rmSync(state, { recursive: true, force: true });
}
