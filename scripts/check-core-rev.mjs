import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected = readFileSync(resolve(root, "rustyera-core.rev"), "utf8").trim();
if (!/^[0-9a-f]{40}$/.test(expected)) {
  throw new Error("rustyera-core.rev must contain one full Git commit SHA");
}

const manifest = readFileSync(resolve(root, "Cargo.toml"), "utf8");
const revisions = [...manifest.matchAll(/rustyera\.git", rev = "([^"]+)"/g)].map(
  (match) => match[1],
);
if (revisions.length !== 5 || revisions.some((revision) => revision !== expected)) {
  throw new Error("all five core workspace dependencies must match rustyera-core.rev");
}

console.log(`rustyera-core revision: ${expected}`);
