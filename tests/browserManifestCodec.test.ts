import { describe, expect, it } from "vitest";

import { encodeBrowserManifest, streamBrowserManifestFiles } from "@/platform/browserManifestCodec";

describe("browser manifest codec", () => {
  it("encodes one transferable buffer while reporting bounded monotonic progress", async () => {
    const progress: Array<[number, number]> = [];
    const files = Array.from({ length: 260 }, (_, index) => ({
      relative_path: `resources/${index}.bin`,
      category: "resource" as const,
      payload: { type: "bytes" as const, value: Uint8Array.of(index & 0xff) },
      content_hash: new Uint8Array(32).fill(index & 0xff),
    }));

    const encoded = await encodeBrowserManifest(
      { project_revision: 7, files },
      (completed, total) => progress.push([completed, total]),
    );

    expect(new TextDecoder().decode(encoded.subarray(0, 8))).toBe("RERMAN01");
    expect(new DataView(encoded.buffer).getBigUint64(8, true)).toBe(7n);
    expect(new DataView(encoded.buffer).getUint32(16, true)).toBe(files.length);
    expect(progress[0]).toEqual([0, 100]);
    expect(progress.at(-1)).toEqual([100, 100]);
    expect(progress.length).toBeLessThanOrEqual(101);
    expect(progress.every((value, index) => index === 0 || progress[index - 1][0] < value[0])).toBe(
      true,
    );
  });

  it("writes UTF-8 text directly with exact scalar and replacement lengths", async () => {
    const text = "ASCII/あ/😀/\ud800/end";
    const hash = new Uint8Array(32).fill(7);

    const encoded = await encodeBrowserManifest({
      project_revision: 1,
      files: [
        {
          relative_path: "ERB/日本語.erb",
          category: "erb",
          payload: { type: "utf8", value: text },
          content_hash: hash,
        },
      ],
    });

    const view = new DataView(encoded.buffer);
    const pathBytes = view.getUint32(21, true);
    const payloadBytes = Number(view.getBigUint64(26, true));
    const payloadOffset = 35 + pathBytes;
    expect(payloadBytes).toBe(new TextEncoder().encode(text).byteLength);
    expect(
      new TextDecoder().decode(encoded.subarray(payloadOffset, payloadOffset + payloadBytes)),
    ).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    expect(encoded.subarray(payloadOffset + payloadBytes)).toEqual(hash);
  });

  it("encodes external resource length and image metadata without resource bytes", async () => {
    const encoded = await encodeBrowserManifest({
      project_revision: 1,
      files: [
        {
          relative_path: "resources/image.png",
          category: "resource",
          payload: {
            type: "external",
            byteLength: 987654,
            imageMetadata: { width: 640, height: 480, format: "png", animated: false },
          },
          content_hash: new Uint8Array(32).fill(9),
        },
      ],
    });
    const view = new DataView(encoded.buffer);
    const pathBytes = view.getUint32(21, true);
    expect(view.getUint8(25)).toBe(2);
    expect(view.getBigUint64(26, true)).toBe(18n);
    const descriptor = 35 + pathBytes;
    expect(view.getBigUint64(descriptor, true)).toBe(987654n);
    expect(view.getUint32(descriptor + 8, true)).toBe(640);
    expect(view.getUint32(descriptor + 12, true)).toBe(480);
  });

  it("streams one final-owned payload at a time without a project-sized output buffer", async () => {
    const progress: Array<[number, number]> = [];
    const prefixes: string[] = [];
    const payloadSizes: number[] = [];
    let activeBytes = 0;
    let peakBytes = 0;
    const manifest = {
      project_revision: 7,
      files: ["one", "two", "three"].map((text, index) => ({
        relative_path: `${index}.erb`,
        category: "erb",
        payload: { type: "utf8" as const, value: text.repeat(1024) },
        content_hash: new Uint8Array(32).fill(index),
      })),
    };

    await streamBrowserManifestFiles(
      manifest,
      async ({ payload, contentHash }) => {
        activeBytes += payload.byteLength + contentHash.byteLength;
        peakBytes = Math.max(peakBytes, activeBytes);
        prefixes.push(new TextDecoder().decode(payload).slice(0, 5));
        payloadSizes.push(payload.byteLength + contentHash.byteLength);
        activeBytes -= payload.byteLength + contentHash.byteLength;
      },
      (completed, total) => progress.push([completed, total]),
    );

    expect(prefixes).toEqual(["oneon", "twotw", "three"]);
    expect(peakBytes).toBe(Math.max(...payloadSizes));
    expect(peakBytes).toBeLessThan(payloadSizes.reduce((total, size) => total + size, 0));
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
