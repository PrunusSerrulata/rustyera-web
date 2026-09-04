#!/usr/bin/env node

import { runBrowserCompatibility } from "./browser-compat-run.mjs";

await runBrowserCompatibility(process.argv);
