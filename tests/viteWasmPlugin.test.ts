import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { rustyeraWasmDevServer } from "../scripts/vite-wasm-plugin";

describe("Vite WASM development server", () => {
  it("serves Vite's dynamic import request without transforming the public module", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-wasm-"));
    await writeFile(path.join(directory, "era_web_wasm.js"), "export const marker = 1;\n");
    const plugin = rustyeraWasmDevServer(directory);
    const use = vi.fn();
    if (typeof plugin.configureServer !== "function") throw new Error("configureServer is missing");
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
  });
});
