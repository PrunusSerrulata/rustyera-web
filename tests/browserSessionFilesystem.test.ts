import { describe, expect, it } from "vitest";

import { createBrowserSessionDirectory } from "@/platform/browserSessionFilesystem";

describe("browser session filesystem", () => {
  it("writes Blob data without treating its MIME type as a stream command", async () => {
    const root = createBrowserSessionDirectory("session");
    const handle = await root.getFileHandle("blob.bin", { create: true });
    const writer = await handle.createWritable();

    await writer.write(new Blob([Uint8Array.of(1, 2, 3)], { type: "application/octet-stream" }));
    await writer.close();

    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it("advances the change token for consecutive equal-length writes", async () => {
    const root = createBrowserSessionDirectory("session");
    const handle = await root.getFileHandle("state.bin", { create: true });
    const firstWriter = await handle.createWritable();
    await firstWriter.write(Uint8Array.of(1));
    await firstWriter.close();
    const first = await handle.getFile();

    const secondWriter = await handle.createWritable();
    await secondWriter.write(Uint8Array.of(2));
    await secondWriter.close();
    const second = await handle.getFile();

    expect(second.size).toBe(first.size);
    expect(second.lastModified).toBeGreaterThan(first.lastModified);
  });
});
