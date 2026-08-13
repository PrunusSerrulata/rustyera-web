import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosisArchiveInput } from "@/core/diagnosis";
import { streamDiagnosisArchiveInWorker } from "@/platform/diagnosis";

class DiagnosisWorkerStub {
  static instances: DiagnosisWorkerStub[] = [];

  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();

  constructor() {
    DiagnosisWorkerStub.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const input = (): DiagnosisArchiveInput => ({
  projectName: "eraFL",
  snapshot: Uint8Array.of(1),
  inputReplay: Uint8Array.of(2),
  logs: "log",
  projectFile: Uint8Array.of(3),
  exportedAt: new Date(2026, 7, 13, 12, 0, 0),
});

describe("diagnosis archive worker stream", () => {
  beforeEach(() => {
    DiagnosisWorkerStub.instances = [];
    vi.stubGlobal("Worker", DiagnosisWorkerStub);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports a chunk only after its host write completes and withholds final 100%", async () => {
    const write = deferred<void>();
    const progress = vi.fn();
    const result = streamDiagnosisArchiveInWorker(input(), () => write.promise, progress);
    const worker = DiagnosisWorkerStub.instances[0]!;

    worker.emit({ chunk: Uint8Array.of(1, 2), completed: 2, total: 4 });
    await flushMicrotasks();
    expect(progress).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    write.resolve();
    await flushMicrotasks();
    expect(progress).toHaveBeenCalledWith({ completed: 2, total: 4 });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "continue" });

    worker.emit({ chunk: Uint8Array.of(3, 4), completed: 4, total: 4 });
    await flushMicrotasks();
    expect(progress).toHaveBeenCalledTimes(1);
    worker.emit({ complete: true });
    await expect(result).resolves.toBe(4);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "synchronous write",
      () =>
        vi.fn(() => {
          throw new Error("sync write");
        }),
    ],
    [
      "asynchronous write",
      () =>
        vi.fn(async () => {
          throw new Error("async write");
        }),
    ],
    ["progress callback", () => vi.fn(async () => undefined)],
  ])("terminates the Worker after a %s failure", async (kind, makeWrite) => {
    const progress =
      kind === "progress callback"
        ? vi.fn(() => {
            throw new Error("progress failed");
          })
        : vi.fn();
    const result = streamDiagnosisArchiveInWorker(input(), makeWrite(), progress);
    const worker = DiagnosisWorkerStub.instances[0]!;

    worker.emit({ chunk: Uint8Array.of(1), completed: 1, total: 2 });

    await expect(result).rejects.toThrow();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid byte metadata before writing", async () => {
    const write = vi.fn(async () => undefined);
    const result = streamDiagnosisArchiveInWorker(input(), write);
    const worker = DiagnosisWorkerStub.instances[0]!;

    worker.emit({ chunk: Uint8Array.of(1), completed: 3, total: 2 });

    await expect(result).rejects.toThrow("无效的字节进度");
    expect(write).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
