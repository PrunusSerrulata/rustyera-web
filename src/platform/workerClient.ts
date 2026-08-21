import type { ProjectProgress } from "@/core/types";

export class WorkerClient {
  private worker: Worker | undefined;
  private lifecycle: "running" | "restarting" | "failed" | "closed" = "running";
  private restartOperation?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private terminalError?: Error;

  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event) => {
      if (this.worker !== worker || this.lifecycle !== "running") return;
      const { id, result, error, type, value } = event.data;
      if (type === "project_progress") {
        this.projectProgressListener?.(value as ProjectProgress);
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker || this.lifecycle !== "running") return;
      this.fail(new Error(event.message || "Worker 运行失败"));
    };
    return worker;
  }

  setProjectProgressListener(listener: ((progress: ProjectProgress) => void) | undefined): void {
    this.projectProgressListener = listener;
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.request(method, args, []);
  }

  callWithTransfer<T>(method: string, args: unknown[], transfer: Transferable[]): Promise<T> {
    return this.request(method, args, transfer);
  }

  private request<T>(method: string, args: unknown[], transfer: Transferable[]): Promise<T> {
    const worker = this.worker;
    if (this.lifecycle !== "running" || !worker)
      return Promise.reject(this.terminalError ?? new Error("Worker 当前不可用"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, args }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(new Error(`Worker ${method} 消息不可克隆：${String(error)}`));
      }
    });
  }

  close(): void {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closed";
    this.detachAndTerminate();
    const error = new Error("Worker 已关闭");
    this.terminalError = error;
    this.rejectPending(error);
  }

  restart(afterTerminate?: () => Promise<void>): Promise<void> {
    if (this.lifecycle === "closed")
      return Promise.reject(this.terminalError ?? new Error("Worker 已关闭"));
    if (this.lifecycle === "restarting" && this.restartOperation) return this.restartOperation;

    this.lifecycle = "restarting";
    this.detachAndTerminate();
    const restarted = new Error("Worker 已重启");
    this.terminalError = restarted;
    this.rejectPending(restarted);
    const operation = this.performRestart(afterTerminate);
    this.restartOperation = operation;
    const clearRestartOperation = () => {
      if (this.restartOperation === operation) this.restartOperation = undefined;
    };
    void operation.then(clearRestartOperation, clearRestartOperation);
    return operation;
  }

  private async performRestart(afterTerminate?: () => Promise<void>): Promise<void> {
    try {
      await afterTerminate?.();
      if (this.lifecycle === "closed") throw this.terminalError ?? new Error("Worker 已关闭");
      const worker = this.createWorker();
      this.worker = worker;
      this.lifecycle = "running";
      this.terminalError = undefined;
    } catch (error) {
      if (this.lifecycle === "closed") throw this.terminalError ?? error;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.lifecycle = "failed";
      this.terminalError = failure;
      throw failure;
    }
  }

  private detachAndTerminate(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  private fail(error: Error): void {
    if (this.lifecycle !== "running") return;
    this.lifecycle = "failed";
    this.terminalError = error;
    this.detachAndTerminate();
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
