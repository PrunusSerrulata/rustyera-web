import { describe, expect, it } from "vitest";

import { encodeBrowserManifest } from "@/platform/browserManifestCodec";

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
});
