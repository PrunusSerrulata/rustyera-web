import { createReadStream } from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

const WASM_FILES = new Set(["era_web_wasm.js", "era_web_wasm_bg.wasm"]);

export function rustyeraWasmDevServer(wasmDirectory: string): Plugin {
  return {
    name: "rustyera-wasm-dev-server",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.match(/^\/__rustyera_wasm\/([^?]+)/)?.[1];
        if (!name || !WASM_FILES.has(name)) return next();
        response.setHeader(
          "Content-Type",
          name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        const stream = createReadStream(path.join(wasmDirectory, name));
        stream.on("error", next);
        stream.pipe(response);
      });
    },
  };
}
