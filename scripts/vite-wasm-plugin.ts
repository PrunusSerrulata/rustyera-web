import { createReadStream } from "node:fs";
import path from "node:path";

import type { HtmlTagDescriptor, Plugin } from "vite";

import { runtimeWasmAssetUrls } from "../src/platform/runtimeWasmAssets";

const WASM_FILES = new Set(["era_web_wasm.js", "era_web_wasm_bg.wasm"]);
const RUNTIME_WORKER_MODULE = "/src/platform/runtime.worker.ts";

type EmittedBundle = Record<
  string,
  | { type: "asset"; fileName: string }
  | { type: "chunk"; fileName: string; facadeModuleId: string | null }
>;

export function runtimeWasmPreloadTags(
  baseUrl: string,
  revision: string,
  bundle: EmittedBundle,
): HtmlTagDescriptor[] {
  const workers = Object.values(bundle).filter(
    (output) =>
      output.type === "chunk" &&
      normalizedModuleId(output.facadeModuleId)?.endsWith(RUNTIME_WORKER_MODULE),
  );
  if (workers.length !== 1) {
    throw new Error(`expected one emitted Runtime Worker entry, found ${workers.length}`);
  }
  const wasm = runtimeWasmAssetUrls(false, baseUrl, revision);
  return [
    preloadModule(`${baseUrl}${workers[0].fileName}`),
    preloadModule(wasm.module),
    {
      tag: "link",
      attrs: {
        rel: "preload",
        href: wasm.binary,
        as: "fetch",
        type: "application/wasm",
        crossorigin: "",
      },
      injectTo: "head",
    },
  ];
}

export function rustyeraWasmBuildPreload(revision: string): {
  app: Plugin;
  worker: Plugin;
} {
  let baseUrl = "/";
  const workerBundle: EmittedBundle = {};
  return {
    app: {
      name: "rustyera-wasm-build-preload",
      apply: "build",
      configResolved(config) {
        baseUrl = config.base;
      },
      transformIndexHtml: {
        order: "post",
        handler() {
          return runtimeWasmPreloadTags(baseUrl, revision, workerBundle);
        },
      },
    },
    worker: {
      name: "rustyera-wasm-worker-entry",
      apply: "build",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (
            output.type !== "chunk" ||
            !normalizedModuleId(output.facadeModuleId)?.endsWith(RUNTIME_WORKER_MODULE)
          )
            continue;
          workerBundle[output.fileName] = {
            type: "chunk",
            fileName: output.fileName,
            facadeModuleId: output.facadeModuleId,
          };
        }
      },
    },
  };
}

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

function preloadModule(href: string): HtmlTagDescriptor {
  return {
    tag: "link",
    attrs: { rel: "modulepreload", href, crossorigin: "" },
    injectTo: "head",
  };
}

function normalizedModuleId(value: string | null): string | undefined {
  return value?.split("?", 1)[0].replaceAll("\\", "/");
}
