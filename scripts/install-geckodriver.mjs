#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { download } from "geckodriver";

const executeFile = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const version = "0.37.1";
const cacheDirectory = path.join(repository, ".rustyera", "webdriver");
const driverPath = await download(version, cacheDirectory);
const { stdout } = await executeFile(driverPath, ["--version"]);
const reportedVersion = stdout.split("\n", 1)[0];
if (reportedVersion !== `geckodriver ${version} (300705c65d1b 2026-07-17 09:25 +0000)`) {
  throw new Error(`unexpected geckodriver version: ${reportedVersion}`);
}
console.log(JSON.stringify({ type: "geckodriver-installed", version, path: driverPath }));
