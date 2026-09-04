import { readFileSync as readSourceFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function readFileSync(path: string, encoding: "utf8"): string {
  const source = readSourceFileSync(path, encoding);
  if (!path.endsWith("/src/styles.css")) return source;
  return source.replace(/@import\s+"([^"]+)";/g, (_statement, relativePath: string) =>
    readSourceFileSync(resolve(dirname(path), relativePath), encoding),
  );
}
