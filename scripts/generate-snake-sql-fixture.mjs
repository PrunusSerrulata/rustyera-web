import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const seedUrl = new URL(
  "../tests/fixtures/snake-sql-project/plugins/qol_data.seed.sql",
  import.meta.url,
);
const databaseUrl = new URL(
  "../tests/fixtures/snake-sql-project/plugins/qol_data.db",
  import.meta.url,
);
const contractUrl = new URL("../tests/fixtures/snake-sql-project/contract.json", import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, "utf8"));
if (contract.schemaVersion !== 1)
  throw new Error(`unsupported contract schema ${contract.schemaVersion}`);
const sqlite = await sqlite3InitModule();
if (sqlite.version.libVersion !== contract.sqliteVersion)
  throw new Error(
    `expected SQLite ${contract.sqliteVersion}, received ${sqlite.version.libVersion}`,
  );

const db = new sqlite.oo1.DB(":memory:", "c");
let bytes;
try {
  db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE; PRAGMA encoding='UTF-8'");
  db.exec(await readFile(seedUrl, "utf8"));
  db.exec("VACUUM");
  bytes = sqlite.capi.sqlite3_js_db_export(db);
} finally {
  db.close();
}

const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== contract.seedSha256)
  throw new Error(`generated fixture SHA-256 ${digest} differs from ${contract.seedSha256}`);
await writeFile(databaseUrl, bytes);
console.log(
  JSON.stringify({
    path: fileURLToPath(databaseUrl),
    sqlite: sqlite.version.libVersion,
    bytes: bytes.byteLength,
    sha256: digest,
  }),
);
