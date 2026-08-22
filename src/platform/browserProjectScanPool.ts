import { scanBrowserProjectFile, type ScannedFile } from "@/platform/browserProjectScanner";
import { createProjectProgressReporter } from "@/platform/browserProjectUtilities";
import {
  browserProjectScanConcurrency,
  isAndroidBrowserHost,
} from "@/platform/browserMemoryPolicy";

export interface BrowserProjectScanRequest {
  relativePath: string;
  file: File;
}

export type BrowserProjectScanWorkerFactory = () => Worker;
export type BrowserProjectScanProgress = (completed: number, total: number) => void;

interface PendingScan {
  resolve: (value: ScannedFile | undefined) => void;
  reject: (error: unknown) => void;
}

class ScanWorkerInfrastructureError extends Error {}

class ScanWorkerSlot {
  private readonly pending = new Map<number, PendingScan>();
  private sequence = 0;
  private closed = false;
  private topLevelSubmitted = false;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail(new ScanWorkerInfrastructureError(event.message || "project scan worker failed"));
    };
    worker.onmessageerror = () => {
      this.fail(new ScanWorkerInfrastructureError("project scan worker message could not be read"));
    };
  }

  async scan(
    request: BrowserProjectScanRequest,
    topLevel: ReadonlySet<string>,
    readBeforeSubmit: boolean,
  ): Promise<ScannedFile | undefined> {
    if (this.closed) {
      return Promise.reject(new ScanWorkerInfrastructureError("project scan worker is closed"));
    }
    const bytes = readBeforeSubmit ? await readProjectFileBytes(request) : undefined;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try {
        const message = {
          id,
          relativePath: request.relativePath,
          ...(bytes ? { bytes } : { file: request.file }),
          ...(this.topLevelSubmitted ? {} : { topLevel: [...topLevel] }),
        };
        if (bytes) this.worker.postMessage(message, { transfer: [bytes.buffer] });
        else this.worker.postMessage(message);
        this.topLevelSubmitted = true;
      } catch (error) {
        this.pending.delete(id);
        reject(
          new ScanWorkerInfrastructureError(error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  close(reason = new ScanWorkerInfrastructureError("project scan worker closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private receive(value: unknown): void {
    if (!isScanWorkerResponse(value)) {
      this.fail(
        new ScanWorkerInfrastructureError("project scan worker returned an invalid response"),
      );
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.ok) pending.resolve(value.result);
    else pending.reject(new Error(value.error));
  }

  private fail(error: ScanWorkerInfrastructureError): void {
    this.close(error);
  }
}

type ScanWorkerResponse =
  { id: number; ok: true; result?: ScannedFile } | { id: number; ok: false; error: string };

function isScanWorkerResponse(value: unknown): value is ScanWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
  if (!Number.isInteger(response.id) || typeof response.ok !== "boolean") return false;
  return response.ok ? "result" in response : typeof response.error === "string";
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./browserProjectScan.worker.ts", import.meta.url), { type: "module" });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Project scan cancelled", "AbortError");
}

async function scanWithWorkers(
  requests: readonly BrowserProjectScanRequest[],
  topLevel: ReadonlySet<string>,
  workerFactory: BrowserProjectScanWorkerFactory,
  signal?: AbortSignal,
  progress?: BrowserProjectScanProgress,
): Promise<Array<ScannedFile | undefined>> {
  const readBeforeSubmit = typeof navigator !== "undefined" && isAndroidBrowserHost(navigator);
  const workerCount = Math.min(
    requests.length,
    scanConcurrencyLimit(),
    Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
  );
  const slots: ScanWorkerSlot[] = [];
  const results = new Array<ScannedFile | undefined>(requests.length);
  const errors = new Array<unknown>(requests.length);
  let next = 0;
  let completed = 0;
  const report = createProjectProgressReporter(requests.length, progress);
  const close = (reason?: unknown) => {
    const error =
      reason instanceof Error
        ? reason
        : new ScanWorkerInfrastructureError(String(reason ?? "project scan worker closed"));
    for (const slot of slots) slot.close(error);
  };
  const onAbort = () => close(abortError(signal!));
  try {
    for (let index = 0; index < workerCount; index += 1) {
      try {
        slots.push(new ScanWorkerSlot(workerFactory()));
      } catch (error) {
        throw new ScanWorkerInfrastructureError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    await Promise.all(
      slots.map(async (slot) => {
        while (next < requests.length && !signal?.aborted) {
          const index = next++;
          try {
            results[index] = await slot.scan(requests[index]!, topLevel, readBeforeSubmit);
            report(++completed);
          } catch (error) {
            errors[index] = error;
            if (error instanceof ScanWorkerInfrastructureError) close(error);
          }
        }
      }),
    );
    if (signal?.aborted) throw abortError(signal);
    const infrastructureError = errors.find(
      (error) => error instanceof ScanWorkerInfrastructureError,
    );
    if (infrastructureError) throw infrastructureError;
    const businessError = errors.find((error) => error !== undefined);
    if (businessError !== undefined) throw businessError;
    return results;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    close();
  }
}

async function scanOnMainThread(
  requests: readonly BrowserProjectScanRequest[],
  topLevel: ReadonlySet<string>,
  signal?: AbortSignal,
  progress?: BrowserProjectScanProgress,
): Promise<Array<ScannedFile | undefined>> {
  const results = new Array<ScannedFile | undefined>(requests.length);
  const errors = new Array<unknown>(requests.length);
  let next = 0;
  let completed = 0;
  const report = createProjectProgressReporter(requests.length, progress);
  const worker = async () => {
    while (next < requests.length && !signal?.aborted) {
      const index = next++;
      try {
        const request = requests[index]!;
        results[index] = scanBrowserProjectFile(
          request.relativePath,
          await readProjectFileBytes(request),
          topLevel,
        );
        report(++completed);
      } catch (error) {
        errors[index] = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(requests.length, scanConcurrencyLimit()) }, () => worker()),
  );
  if (signal?.aborted) throw abortError(signal);
  const firstError = errors.find((error) => error !== undefined);
  if (firstError !== undefined) throw firstError;
  return results;
}

async function readProjectFileBytes(request: BrowserProjectScanRequest): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.file.arrayBuffer());
  if (Number.isSafeInteger(request.file.size) && bytes.byteLength !== request.file.size) {
    throw new Error(
      `项目文件读取不完整：${request.relativePath}（预期 ${request.file.size} 字节，实际 ${bytes.byteLength} 字节）`,
    );
  }
  return bytes;
}

function scanConcurrencyLimit(): number {
  return typeof navigator !== "undefined" ? browserProjectScanConcurrency(navigator) : 8;
}

export async function scanBrowserProjectFilesOffThread(
  requests: readonly BrowserProjectScanRequest[],
  topLevel: ReadonlySet<string>,
  signal?: AbortSignal,
  workerFactory: BrowserProjectScanWorkerFactory = defaultWorkerFactory,
  progress?: BrowserProjectScanProgress,
): Promise<Array<ScannedFile | undefined>> {
  if (requests.length === 0) return [];
  if (signal?.aborted) throw abortError(signal);
  let completed = 0;
  const monotonicProgress = progress
    ? (nextCompleted: number, total: number) => {
        if (nextCompleted <= completed) return;
        completed = nextCompleted;
        progress(completed, total);
      }
    : undefined;
  if (typeof Worker !== "undefined" || workerFactory !== defaultWorkerFactory) {
    try {
      return await scanWithWorkers(requests, topLevel, workerFactory, signal, monotonicProgress);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (!(error instanceof ScanWorkerInfrastructureError)) throw error;
    }
  }
  return scanOnMainThread(requests, topLevel, signal, monotonicProgress);
}

export async function scanBrowserProjectFileOffThread(
  relativePath: string,
  file: File,
  topLevel: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ScannedFile | undefined> {
  return (await scanBrowserProjectFilesOffThread([{ relativePath, file }], topLevel, signal))[0];
}
