import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runtimeWasmPreloadTags, rustyeraWasmDevServer } from "../scripts/vite-wasm-plugin";

describe("Vite WASM development server", () => {
  it("serves Vite's dynamic import request without transforming the public module", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-wasm-"));
    try {
      await writeFile(path.join(directory, "era_web_wasm.js"), "export const marker = 1;\n");
      const plugin = rustyeraWasmDevServer(directory);
      const use = vi.fn();
      if (typeof plugin.configureServer !== "function")
        throw new Error("configureServer is missing");
      plugin.configureServer.call({} as never, { middlewares: { use } } as never);
      const middleware = use.mock.calls[0]?.[0];
      if (typeof middleware !== "function") throw new Error("WASM middleware is missing");
      const response = Object.assign(new PassThrough(), { setHeader: vi.fn() });
      const body = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      });
      const next = vi.fn();

      middleware({ url: "/__rustyera_wasm/era_web_wasm.js?import" }, response, next);

      await expect(body).resolves.toBe("export const marker = 1;\n");
      expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/javascript");
      expect(next).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preloads the emitted Worker and both versioned WASM assets from the Pages base", () => {
    expect(
      runtimeWasmPreloadTags("/rustyera-web/", "abc123", {
        "assets/index-app.js": {
          type: "chunk",
          fileName: "assets/index-app.js",
          facadeModuleId: "/checkout/src/main.ts",
        },
        "assets/worker-output.js": {
          type: "chunk",
          fileName: "assets/worker-output.js",
          facadeModuleId: "/checkout/src/platform/runtime.worker.ts?worker_file&type=module",
        },
      }),
    ).toEqual([
      {
        tag: "link",
        attrs: {
          rel: "modulepreload",
          href: "/rustyera-web/assets/worker-output.js",
          crossorigin: "",
        },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: {
          rel: "modulepreload",
          href: "/rustyera-web/wasm/era_web_wasm.js?v=abc123",
          crossorigin: "",
        },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: {
          rel: "preload",
          href: "/rustyera-web/wasm/era_web_wasm_bg.wasm?v=abc123",
          as: "fetch",
          type: "application/wasm",
          crossorigin: "",
        },
        injectTo: "head",
      },
    ]);
  });

  it("rejects a production bundle without the Runtime Worker entry", () => {
    expect(() =>
      runtimeWasmPreloadTags("/rustyera-web/", "abc123", {
        "assets/index.js": {
          type: "chunk",
          fileName: "assets/index.js",
          facadeModuleId: "/checkout/src/main.ts",
        },
      }),
    ).toThrow("expected one emitted Runtime Worker entry, found 0");
  });

  it("rejects duplicate Runtime Worker entries", () => {
    expect(() =>
      runtimeWasmPreloadTags("/rustyera-web/", "abc123", {
        "assets/worker-a.js": {
          type: "chunk",
          fileName: "assets/worker-a.js",
          facadeModuleId: "/checkout/src/platform/runtime.worker.ts",
        },
        "assets/worker-b.js": {
          type: "chunk",
          fileName: "assets/worker-b.js",
          facadeModuleId: "C:\\checkout\\src\\platform\\runtime.worker.ts?worker_file",
        },
      }),
    ).toThrow("expected one emitted Runtime Worker entry, found 2");
  });
});
