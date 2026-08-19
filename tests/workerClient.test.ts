import { afterEach, expect, it, vi } from "vitest";

import { WorkerClient } from "@/platform/workerClient";

class ControlledWorker {
  static current: ControlledWorker;

  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  readonly messages: unknown[] = [];
  readonly terminate = vi.fn();

  constructor() {
    ControlledWorker.current = this;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

afterEach(() => vi.unstubAllGlobals());

it("rejects cleanup and later requests immediately after the worker terminates", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const worker = ControlledWorker.current;
  const active = client.call("pump");
  const activeRejection = expect(active).rejects.toThrow("runtime worker crashed");

  worker.onerror?.({ message: "runtime worker crashed" } as ErrorEvent);

  await activeRejection;
  await expect(client.call("cancelProjectFile")).rejects.toThrow("runtime worker crashed");
  expect(worker.messages).toHaveLength(1);
});

it("rejects requests made after an explicit close", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const worker = ControlledWorker.current;

  client.close();

  await expect(client.call("pump")).rejects.toThrow("Worker 已关闭");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.messages).toHaveLength(0);
});
