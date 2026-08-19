import type { ProjectProgress } from "@/core/types";

export class WorkerClient {
  private readonly worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  private projectProgressListener?: (progress: ProjectProgress) => void;
  private terminalError?: Error;

  constructor() {
    this.worker.onmessage = (event) => {
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
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "Worker 运行失败"));
    };
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
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, method, args }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(new Error(`Worker ${method} 消息不可克隆：${String(error)}`));
      }
    });
  }

  close(): void {
    this.worker.terminate();
    this.fail(new Error("Worker 已关闭"));
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
