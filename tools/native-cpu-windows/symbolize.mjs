import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, win32 } from "node:path";

assert.equal(process.platform, "win32", "Native CPU ETW tools are Windows-only");
const args = process.argv.slice(2);
assert.equal(
  args.length,
  5,
  "usage: symbolize.mjs absoluteEXE absolutePDB absoluteRvaArrayJSON freshAbsoluteOutputJSON absoluteLlvmBinDirectory",
);
function localAbsolute(p) {
  assert.match(p, /^[A-Za-z]:[\\/]/, "local drive-absolute path required; no UNC/network paths");
  return resolve(p);
}
const [exe, pdb, input, output, tools] = args.map(localAbsolute);
const pdbutil = `${tools}/llvm-pdbutil.exe`,
  symbolizer = `${tools}/llvm-symbolizer.exe`;
for (const p of [exe, pdb, input]) localAbsolute(realpathSync(p));
const rawPaths = Object.fromEntries(
  ["pdb-summary", "symbolizer"].map((name) => [
    name,
    { stdout: `${output}.${name}.stdout.txt`, stderr: `${output}.${name}.stderr.txt` },
  ]),
);
for (const p of [output, ...Object.values(rawPaths).flatMap((p) => Object.values(p))])
  assert.equal(existsSync(p), false, `fresh output required: ${p}`);
const fd = openSync(output, "wx");
const report = {
  schemaVersion: 1,
  status: "failed",
  basis: "Offline main-image RVA symbolization, not samples, CPU weights or stacks",
  exe,
  pdb,
  input,
  commands: [],
  rawPaths,
};
let failure;
const environment = { ...process.env };
for (const key of [
  "_NT_SYMBOL_PATH",
  "_NT_ALT_SYMBOL_PATH",
  "DEBUGINFOD_URLS",
  "LLVM_SYMBOLIZER_OPTS",
  "LLVM_ADDR2LINE_OPTS",
])
  environment[key] = "";
async function sha256(p) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest("hex");
}
async function run(name, executable, arguments_, stdin = "") {
  const record = {
    executable,
    arguments: arguments_,
    timeoutMs: 10000,
    startedAt: new Date().toISOString(),
  };
  report.commands.push(record);
  const result = await new Promise((done) => {
    const child = execFile(
      executable,
      arguments_,
      {
        cwd: dirname(pdb),
        env: environment,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => done({ error, stdout, stderr }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
  record.endedAt = new Date().toISOString();
  record.exitCode = result.error?.code ?? 0;
  record.signal = result.error?.signal ?? null;
  writeFileSync(rawPaths[name].stdout, result.stdout, { flag: "wx" });
  writeFileSync(rawPaths[name].stderr, result.stderr, { flag: "wx" });
  if (result.error)
    throw new Error(`${name} failed (${result.error.code ?? "unknown"}): raw output retained`, {
      cause: result.error,
    });
  return result.stdout;
}
function peIdentity(bytes) {
  function extent(at, length) {
    assert.ok(
      Number.isSafeInteger(at) &&
        Number.isSafeInteger(length) &&
        at >= 0 &&
        length >= 0 &&
        at + length <= bytes.length,
      "PE bounds",
    );
  }
  function u16(at) {
    extent(at, 2);
    return bytes.readUInt16LE(at);
  }
  function u32(at) {
    extent(at, 4);
    return bytes.readUInt32LE(at);
  }
  assert.equal(u16(0), 0x5a4d);
  const pe = u32(0x3c);
  assert.equal(u32(pe), 0x00004550);
  assert.equal(u16(pe + 4), 0x8664, "AMD64 PE required");
  const sectionCount = u16(pe + 6),
    optionalSize = u16(pe + 20),
    optional = pe + 24;
  assert.ok(sectionCount > 0 && sectionCount <= 96 && optionalSize >= 168);
  extent(optional, optionalSize);
  assert.equal(u16(optional), 0x20b, "PE32+ required");
  const imageSize = u32(optional + 56),
    headerSize = u32(optional + 60),
    imageBase = bytes.readBigUInt64LE(optional + 24);
  assert.ok(imageSize > 0 && u32(optional + 108) > 6, "PE debug directory required");
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = optional + optionalSize + i * 40;
    extent(at, 40);
    sections.push({
      virtualSize: u32(at + 8),
      virtualAddress: u32(at + 12),
      rawSize: u32(at + 16),
      rawAddress: u32(at + 20),
    });
  }
  function rvaOffset(rva, length) {
    assert.ok(rva + length <= imageSize, "RVA outside image");
    if (rva < headerSize) {
      assert.ok(rva + length <= headerSize);
      extent(rva, length);
      return rva;
    }
    const candidates = sections.filter(
      (s) => rva >= s.virtualAddress && rva + length <= s.virtualAddress + s.rawSize,
    );
    assert.equal(candidates.length, 1, "unambiguous initialized RVA section");
    const at = candidates[0].rawAddress + rva - candidates[0].virtualAddress;
    extent(at, length);
    return at;
  }
  const debugRva = u32(optional + 112 + 6 * 8),
    debugSize = u32(optional + 116 + 6 * 8);
  assert.ok(debugSize > 0 && debugSize % 28 === 0 && debugSize <= 28 * 128);
  const directory = rvaOffset(debugRva, debugSize),
    records = [];
  for (let at = directory; at < directory + debugSize; at += 28) {
    if (u32(at + 12) !== 2) continue;
    const size = u32(at + 16),
      rva = u32(at + 20),
      raw = u32(at + 24);
    assert.ok(size >= 25 && size <= 32768);
    extent(raw, size);
    if (rva !== 0) assert.equal(rvaOffset(rva, size), raw, "CodeView file/RVA pointers disagree");
    assert.equal(bytes.toString("ascii", raw, raw + 4), "RSDS", "only RSDS CodeView is supported");
    const hex = (value, width) => value.toString(16).padStart(width, "0");
    const guid = `${hex(u32(raw + 4), 8)}-${hex(u16(raw + 8), 4)}-${hex(u16(raw + 10), 4)}-${bytes.subarray(raw + 12, raw + 14).toString("hex")}-${bytes.subarray(raw + 14, raw + 20).toString("hex")}`;
    const end = bytes.indexOf(0, raw + 24);
    assert.ok(end >= raw + 24 && end < raw + size, "terminated PDB path");
    const pdbPath = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(raw + 24, end));
    assert.ok(pdbPath.length > 0);
    records.push({ guid, age: u32(raw + 20), pdbPath });
  }
  assert.equal(records.length, 1, "exactly one RSDS record required");
  return { machine: "AMD64", imageSize, imageBase: imageBase.toString(), ...records[0] };
}
function summaryIdentity(raw) {
  const guids = [
    ...raw.matchAll(
      /^\s*Guid:\s*\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?\s*$/gim,
    ),
  ];
  const ages = [...raw.matchAll(/^\s*Age:\s*([0-9]+)\s*$/gim)];
  assert.equal(guids.length, 1, "unambiguous llvm-pdbutil Guid required");
  assert.equal(ages.length, 1, "unambiguous llvm-pdbutil Age required");
  const age = Number(ages[0][1]);
  assert.ok(Number.isSafeInteger(age) && age >= 0 && age <= 0xffffffff);
  return { guid: guids[0][1].toLowerCase(), age };
}
function address(value) {
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
    return BigInt(value);
  }
  assert.equal(typeof value, "string");
  assert.match(value, /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/);
  return BigInt(value);
}
function parseSymbolRecords(text) {
  const result = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (/\s/.test(c)) continue;
      assert.equal(c, "{", "symbolizer JSON object stream required");
      start = i;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      assert.ok(depth >= 0);
      if (depth === 0) {
        result.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  assert.equal(start, -1, "complete symbolizer JSON stream");
  return result;
}
try {
  assert.ok(existsSync(pdbutil) && existsSync(symbolizer), "installed LLVM tools required");
  assert.ok(statSync(exe).isFile() && statSync(exe).size <= 256 * 1024 * 1024, "EXE <=256MiB");
  assert.ok(statSync(pdb).isFile() && statSync(pdb).size <= 2 * 1024 * 1024 * 1024, "PDB <=2GiB");
  assert.ok(statSync(input).isFile() && statSync(input).size <= 1024 * 1024, "RVA input <=1MiB");
  report.exeSha256 = await sha256(exe);
  report.pdbSha256 = await sha256(pdb);
  report.inputSha256 = await sha256(input);
  const pe = peIdentity(readFileSync(exe));
  report.peIdentity = pe;
  const requested = JSON.parse(readFileSync(input, "utf8"));
  assert.ok(
    Array.isArray(requested) && requested.length > 0 && requested.length <= 4096,
    "1..4096 RVAs required",
  );
  const rvas = requested.map(address);
  assert.ok(
    rvas.every((rva) => rva < BigInt(pe.imageSize)),
    "RVA in image bounds",
  );
  assert.equal(new Set(rvas.map(String)).size, rvas.length, "unique input RVAs required");
  report.rvas = rvas.map(String);
  const pdbSummary = summaryIdentity(await run("pdb-summary", pdbutil, ["dump", "-summary", pdb]));
  report.pdbIdentity = pdbSummary;
  assert.equal(pdbSummary.guid, pe.guid, "PE/PDB GUID mismatch");
  assert.equal(pdbSummary.age, pe.age, "PE/PDB age mismatch");
  assert.ok(
    !pe.pdbPath.startsWith("\\\\") && !pe.pdbPath.startsWith("//"),
    "network RSDS paths refused",
  );
  const basename = win32.basename(pe.pdbPath);
  assert.equal(
    win32.basename(pdb).toLowerCase(),
    basename.toLowerCase(),
    "input PDB basename must match RSDS",
  );
  const candidates = new Set([resolve(dirname(exe), basename), resolve(dirname(pdb), basename)]);
  if (/^[A-Za-z]:[\\/]/.test(pe.pdbPath)) candidates.add(localAbsolute(pe.pdbPath));
  else {
    assert.ok(
      !win32.isAbsolute(pe.pdbPath) && !pe.pdbPath.split(/[\\/]/).includes(".."),
      "safe relative RSDS path required",
    );
    candidates.add(resolve(dirname(pdb), pe.pdbPath));
  }
  report.existingPdbCandidates = [];
  for (const candidate of candidates)
    if (existsSync(candidate)) {
      localAbsolute(realpathSync(candidate));
      assert.ok(statSync(candidate).isFile() && statSync(candidate).size <= 2 * 1024 * 1024 * 1024);
      const hash = await sha256(candidate);
      assert.equal(hash, report.pdbSha256, "conflicting discoverable PDB candidate");
      report.existingPdbCandidates.push({ path: candidate, sha256: hash });
    }
  const raw = await run(
    "symbolizer",
    symbolizer,
    [
      `--obj=${exe}`,
      "--relative-address",
      "--output-style=JSON",
      "--no-debuginfod",
      `--fallback-debug-path=${dirname(pdb)}`,
      `--debug-file-directory=${dirname(pdb)}`,
    ],
    rvas.map((rva) => `0x${rva.toString(16)}\n`).join(""),
  );
  const symbols = parseSymbolRecords(raw);
  assert.equal(symbols.length, rvas.length, "one symbol result per RVA");
  for (let i = 0; i < symbols.length; i++) {
    const record = symbols[i];
    assert.ok(record && typeof record === "object" && !Array.isArray(record));
    assert.equal(record.Error, undefined, "symbolizer error record");
    assert.equal(typeof record.ModuleName, "string");
    assert.equal(
      realpathSync(record.ModuleName).toLowerCase(),
      realpathSync(exe).toLowerCase(),
      "symbolizer module identity",
    );
    assert.equal(address(record.Address), rvas[i], "symbolizer relative-address order mismatch");
    assert.ok(Array.isArray(record.Symbol), "symbolizer Symbol array required");
  }
  assert.equal(await sha256(exe), report.exeSha256, "EXE changed during symbolization");
  assert.equal(await sha256(pdb), report.pdbSha256, "PDB changed during symbolization");
  report.symbols = symbols;
  report.matchedPePdb = true;
  report.pdbSelection =
    "GUID/age matched; known discoverable PDB candidates byte-identical. LLVM does not report its loaded PDB path; no independent loaded-path proof.";
  report.status = "complete";
} catch (error) {
  failure = error;
  report.error = { name: error.name, message: error.message };
} finally {
  writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
  closeSync(fd);
}
if (failure) {
  console.error(failure.message);
  process.exitCode = 1;
} else console.log(JSON.stringify({ status: report.status, output, count: report.symbols.length }));
