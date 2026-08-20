import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { wasmAssetRevision } from "../scripts/wasm-assets";
import { runtimeWasmAssetUrls } from "../src/platform/runtimeWasmAssets";

describe("runtime WASM asset versioning", () => {
  it("versions both Pages runtime assets with the same build fingerprint", () => {
    expect(runtimeWasmAssetUrls(false, "/rustyera-web/", "abc123")).toEqual({
      module: "/rustyera-web/wasm/era_web_wasm.js?v=abc123",
      binary: "/rustyera-web/wasm/era_web_wasm_bg.wasm?v=abc123",
    });
  });

  it("keeps development assets on the untransformed Vite endpoint", () => {
    expect(runtimeWasmAssetUrls(true, "/ignored/", "core/revision")).toEqual({
      module: "/__rustyera_wasm/era_web_wasm.js?v=core%2Frevision",
      binary: "/__rustyera_wasm/era_web_wasm_bg.wasm?v=core%2Frevision",
    });
  });

  it("changes the build fingerprint when either emitted runtime asset changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-wasm-assets-"));
    try {
      await writeFile(path.join(directory, "era_web_wasm.js"), "export default 1;\n");
      await writeFile(path.join(directory, "era_web_wasm_bg.wasm"), Uint8Array.of(0, 1, 2));
      const initial = wasmAssetRevision(directory, "fallback");

      await writeFile(path.join(directory, "era_web_wasm.js"), "export default 2;\n");
      const changedModule = wasmAssetRevision(directory, "fallback");
      expect(changedModule).not.toBe(initial);

      await writeFile(path.join(directory, "era_web_wasm_bg.wasm"), Uint8Array.of(0, 1, 3));

      expect(wasmAssetRevision(directory, "fallback")).not.toBe(changedModule);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the declared fallback before the WASM build exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rustyera-wasm-assets-empty-"));
    try {
      expect(wasmAssetRevision(directory, "core-deadbeef")).toBe("core-deadbeef");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
