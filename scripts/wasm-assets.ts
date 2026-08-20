import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const WASM_ASSET_NAMES = ["era_web_wasm.js", "era_web_wasm_bg.wasm"] as const;

export function wasmAssetRevision(directory: string, fallback: string): string {
  const hash = createHash("sha256");
  try {
    for (const name of WASM_ASSET_NAMES) {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(path.join(directory, name)));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  return hash.digest("hex");
}
