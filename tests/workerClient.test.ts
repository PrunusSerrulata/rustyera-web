import { afterEach, expect, it, vi } from "vitest";

import { WorkerClient } from "@/platform/workerClient";

class ControlledWorker {
  static current: ControlledWorker;
  static readonly instances: ControlledWorker[] = [];
  static failNextConstruction = false;

  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  readonly messages: unknown[] = [];
  readonly terminate = vi.fn();

  constructor() {
    if (ControlledWorker.failNextConstruction) {
      ControlledWorker.failNextConstruction = false;
      throw new Error("worker construction failed");
    }
    ControlledWorker.current = this;
    ControlledWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

afterEach(() => {
  ControlledWorker.instances.length = 0;
  ControlledWorker.failNextConstruction = false;
  vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

it("terminates the old worker and accepts requests on a fresh worker after restart", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const first = ControlledWorker.current;
  expect(client.generation).toBe(1);
  const active = client.call("pump");
  const activeRejection = expect(active).rejects.toThrow("Worker 已重启");

  await client.restart();
  const second = ControlledWorker.current;
  expect(client.generation).toBe(2);

  await activeRejection;
  expect(second).not.toBe(first);
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(first.onmessage).toBeNull();
  expect(first.onerror).toBeNull();

  const resumed = client.call<number>("pump");
  const request = second.messages[0] as { id: number };
  second.onmessage?.({ data: { id: request.id, result: 7 } } as MessageEvent);
  await expect(resumed).resolves.toBe(7);
});

it("shares one worker replacement across concurrent restarts", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const first = ControlledWorker.current;
  const release = deferred();

  const firstRestart = client.restart(() => release.promise);
  const secondRestart = client.restart(() => Promise.resolve());

  expect(first.terminate).toHaveBeenCalledOnce();
  expect(ControlledWorker.instances).toEqual([first]);
  release.resolve();
  await Promise.all([firstRestart, secondRestart]);

  expect(ControlledWorker.instances).toHaveLength(2);
  expect(ControlledWorker.current).not.toBe(first);
});

it("does not recreate a worker when close wins a pending restart", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const first = ControlledWorker.current;
  const release = deferred();
  const restarting = client.restart(() => release.promise);

  client.close();
  release.resolve();

  await expect(restarting).rejects.toThrow("Worker 已关闭");
  await expect(client.restart()).rejects.toThrow("Worker 已关闭");
  await expect(client.call("pump")).rejects.toThrow("Worker 已关闭");
  expect(ControlledWorker.instances).toEqual([first]);
  expect(first.terminate).toHaveBeenCalledOnce();
});

it("can retry a worker replacement after construction fails", async () => {
  vi.stubGlobal("Worker", ControlledWorker);
  const client = new WorkerClient();
  const first = ControlledWorker.current;
  ControlledWorker.failNextConstruction = true;

  await expect(client.restart()).rejects.toThrow("worker construction failed");
  await expect(client.call("pump")).rejects.toThrow("worker construction failed");
  await expect(client.restart()).resolves.toBeUndefined();

  expect(first.terminate).toHaveBeenCalledOnce();
  expect(ControlledWorker.instances).toHaveLength(2);
});
