import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const revision = process.argv[2] ?? "";
if (!/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error("core revision must be a full 40-character lowercase commit SHA");
}

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "Cargo.toml");
const source = 'git = "https://github.com/PrunusSerrulata/rustyera-core.git"';
const manifest = readFileSync(manifestPath, "utf8");
const dependencyCount = manifest.split(source).length - 1;
if (dependencyCount !== 5) {
  throw new Error("expected five unpinned rustyera-core workspace dependencies");
}

writeFileSync(manifestPath, manifest.replaceAll(source, `${source}, rev = "${revision}"`));
writeFileSync(resolve(root, "rustyera-core.rev"), `${revision}\n`);
console.log(`Pinned rustyera-core dependencies to ${revision}`);
