import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadProjectFileInWorker,
  type ProjectFileUploadRuntime,
} from "@/platform/projectFileWorker";

function uploadRuntime() {
  const chunks: Uint8Array[] = [];
  const runtime: ProjectFileUploadRuntime = {
    beginProjectFile: vi.fn(),
    appendProjectFile: vi.fn((bytes) => chunks.push(new Uint8Array(bytes))),
    finishProjectFile: vi.fn(() => ({ cacheImported: true })),
    cancelProjectFile: vi.fn(),
  };
  return { chunks, runtime };
}

describe("packaged project worker reader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads bounded slices inside the worker and reports acknowledged progress", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
    const file = new File([bytes], "large.reraproj");
    const wholeRead = vi.fn();
    Object.defineProperty(file, "arrayBuffer", { value: wholeRead });
    const { chunks, runtime } = uploadRuntime();
    const progress = vi.fn();
    const yieldTurn = vi.fn(async () => undefined);

    await expect(loadProjectFileInWorker(runtime, file, progress, {}, yieldTurn)).resolves.toEqual({
      cacheImported: true,
    });

    expect(runtime.beginProjectFile).toHaveBeenCalledWith(bytes.byteLength);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([4 * 1024 * 1024, 1024 * 1024]);
    expect(chunks[0][0]).toBe(7);
    expect(chunks[1].at(-1)).toBe(7);
    expect(progress.mock.calls).toEqual([
      [{ stage: "scanning", completed: 4 * 1024 * 1024, total: bytes.byteLength }],
      [{ stage: "scanning", completed: bytes.byteLength, total: bytes.byteLength }],
    ]);
    expect(yieldTurn).toHaveBeenCalledTimes(2);
    expect(wholeRead).not.toHaveBeenCalled();
  });

  it("cancels after a Blob read failure, preserves it, and permits a retry", async () => {
    const broken = new File([], "broken.reraproj");
    Object.defineProperty(broken, "size", { value: 5 * 1024 * 1024 });
    let slices = 0;
    Object.defineProperty(broken, "slice", {
      value: (start: number, end: number) => ({
        arrayBuffer: async () => {
          slices += 1;
          if (slices === 2) throw new Error("project blob read failed");
          return new ArrayBuffer(end - start);
        },
      }),
    });
    const { runtime } = uploadRuntime();

    await expect(
      loadProjectFileInWorker(
        runtime,
        broken,
        () => undefined,
        {},
        async () => undefined,
      ),
    ).rejects.toThrow("project blob read failed");
    expect(runtime.cancelProjectFile).toHaveBeenCalledOnce();

    const retry = new File([Uint8Array.of(1, 2, 3)], "retry.reraproj");
    await expect(
      loadProjectFileInWorker(
        runtime,
        retry,
        () => undefined,
        {},
        async () => undefined,
      ),
    ).resolves.toEqual({ cacheImported: true });
    expect(runtime.beginProjectFile).toHaveBeenLastCalledWith(3);
  });

  it("uses asynchronous reads and smaller acknowledged chunks for constrained devices", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(9);
    const file = new File([bytes], "mobile.reraproj");
    const asyncRead = vi.fn(async (size: number) => new ArrayBuffer(size));
    Object.defineProperty(file, "slice", {
      value: (start: number, end: number) =>
        ({
          size: end - start,
          arrayBuffer: () => asyncRead(end - start),
        }) as unknown as Blob,
    });
    const syncRead = vi.fn((blob: Blob) => new ArrayBuffer(blob.size));
    vi.stubGlobal(
      "FileReaderSync",
      class {
        readAsArrayBuffer = syncRead;
      },
    );
    const { chunks, runtime } = uploadRuntime();

    await loadProjectFileInWorker(
      runtime,
      file,
      () => undefined,
      { chunkBytes: 1024 * 1024 },
      async () => undefined,
    );

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      1024 * 1024,
      1024 * 1024,
      1024 * 1024,
    ]);
    expect(asyncRead).toHaveBeenCalledTimes(3);
    expect(syncRead).not.toHaveBeenCalled();
  });
});
