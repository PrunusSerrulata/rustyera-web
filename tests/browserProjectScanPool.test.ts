import { describe, expect, it, vi } from "vitest";

import {
  scanBrowserProjectFilesOffThread,
  type BrowserProjectScanWorkerFactory,
} from "@/platform/browserProjectScanPool";
import { createBrowserProjectScanHandler } from "@/platform/browserProjectScan.worker";

type WorkerReply = (worker: FakeWorker, message: any) => void;

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly terminate = vi.fn();

  constructor(private readonly reply: WorkerReply) {}

  postMessage(message: any, options?: StructuredSerializeOptions): void {
    if (options?.transfer) {
      expect(options.transfer).toEqual([message.bytes.buffer]);
    }
    this.reply(this, message);
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function scanned(path: string) {
  return {
    relative_path: path,
    category: "erb",
    payload: { type: "utf8" as const, value: path },
    content_hash: new Uint8Array(32),
  };
}

function request(path: string, read = vi.fn()) {
  return {
    relativePath: path,
    file: { arrayBuffer: read } as unknown as File,
    read,
  };
}

describe("browser project scan worker batches", () => {
  it("reuses the initialized top-level set when later worker messages omit it", async () => {
    const replies: any[] = [];
    const handler = createBrowserProjectScanHandler((message) => replies.push(message));
    const file = {
      arrayBuffer: async () => new TextEncoder().encode("@LOOSE\nRETURN\n").buffer,
    } as File;

    await handler({
      data: { id: 1, relativePath: "loose.erb", file, topLevel: ["erb"] },
    } as MessageEvent);
    await handler({ data: { id: 2, relativePath: "loose.erb", file } } as MessageEvent);

    expect(replies).toEqual([
      { id: 1, ok: true, result: undefined },
      { id: 2, ok: true, result: undefined },
    ]);
  });

  it("scans transferred Android bytes without requiring a cloned File", async () => {
    const replies: any[] = [];
    const handler = createBrowserProjectScanHandler((message) => replies.push(message));
    const bytes = new TextEncoder().encode("@MAIN\nRETURN\n");

    await handler({
      data: { id: 1, relativePath: "ERB/main.erb", bytes, topLevel: ["erb"] },
    } as MessageEvent);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id: 1,
      ok: true,
      result: {
        relative_path: "ERB/main.erb",
        category: "erb",
        payload: { type: "utf8", value: "@MAIN\nRETURN\n" },
      },
    });
  });

  it("caps memory-constrained browser scans at two readers and submits top-level names once per worker", async () => {
    vi.stubGlobal("navigator", {
      hardwareConcurrency: 8,
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    });
    const messages: any[][] = [];
    const factory: BrowserProjectScanWorkerFactory = () => {
      const workerMessages: any[] = [];
      messages.push(workerMessages);
      return new FakeWorker((self, message) => {
        workerMessages.push(message);
        expect(message.file).toBeUndefined();
        expect(message.bytes).toBeInstanceOf(Uint8Array);
        self.respond({ id: message.id, ok: true, result: scanned(message.relativePath) });
      }) as unknown as Worker;
    };

    try {
      await scanBrowserProjectFilesOffThread(
        [request("a.erb"), request("b.erb"), request("c.erb"), request("d.erb")],
        new Set(["erb", "csv"]),
        undefined,
        factory,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(messages).toHaveLength(2);
    expect(messages.flat().filter((message) => message.topLevel !== undefined)).toHaveLength(2);
    expect(messages.every((workerMessages) => workerMessages[0]?.topLevel)).toBe(true);
  });

  it("reads Android provider files before transferring their bytes to scan workers", async () => {
    vi.stubGlobal("navigator", {
      hardwareConcurrency: 4,
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent: "Mozilla/5.0 (Android 17; Mobile; rv:154.0) Gecko/154.0 Firefox/154.0",
    });
    const source = request(
      "main.erb",
      vi.fn(async () => new TextEncoder().encode("@MAIN\nRETURN\n").buffer),
    );
    Object.defineProperty(source.file, "size", { value: 13 });
    const messages: any[] = [];
    const worker = new FakeWorker((self, message) => {
      messages.push(message);
      self.respond({ id: message.id, ok: true, result: scanned(message.relativePath) });
    });

    try {
      await expect(
        scanBrowserProjectFilesOffThread(
          [source],
          new Set(["erb"]),
          undefined,
          () => worker as unknown as Worker,
        ),
      ).resolves.toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(source.read).toHaveBeenCalledOnce();
    expect(messages[0]).toMatchObject({ relativePath: "main.erb" });
    expect(messages[0].file).toBeUndefined();
    expect(new TextDecoder().decode(messages[0].bytes)).toBe("@MAIN\nRETURN\n");
  });

  it("rejects a truncated Android provider read instead of compiling a partial project", async () => {
    vi.stubGlobal("navigator", {
      hardwareConcurrency: 4,
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 17; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
    });
    const source = request(
      "ERB/FUNCTIONS.ERB",
      vi.fn(async () => Uint8Array.of(1, 2).buffer),
    );
    Object.defineProperty(source.file, "size", { value: 8 });
    const worker = new FakeWorker(() => undefined);

    try {
      await expect(
        scanBrowserProjectFilesOffThread(
          [source],
          new Set(["erb"]),
          undefined,
          () => worker as unknown as Worker,
        ),
      ).rejects.toThrow("项目文件读取不完整：ERB/FUNCTIONS.ERB（预期 8 字节，实际 2 字节）");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("preserves direct File submission for iOS and iPadOS scan workers", async () => {
    for (const device of [
      {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
    ]) {
      vi.stubGlobal("navigator", { hardwareConcurrency: 4, ...device });
      const source = request("main.erb");
      const messages: any[] = [];
      const worker = new FakeWorker((self, message) => {
        messages.push(message);
        self.respond({ id: message.id, ok: true, result: scanned(message.relativePath) });
      });

      try {
        await expect(
          scanBrowserProjectFilesOffThread(
            [source],
            new Set(["erb"]),
            undefined,
            () => worker as unknown as Worker,
          ),
        ).resolves.toHaveLength(1);

        expect(source.read).not.toHaveBeenCalled();
        expect(messages[0].file).toBe(source.file);
        expect(messages[0].bytes).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("merges out-of-order worker replies by request order and closes the batch", async () => {
    const workers: FakeWorker[] = [];
    const factory: BrowserProjectScanWorkerFactory = () => {
      const worker = new FakeWorker((self, message) => {
        const delay = message.relativePath === "b.erb" ? 0 : 5;
        setTimeout(
          () => self.respond({ id: message.id, ok: true, result: scanned(message.relativePath) }),
          delay,
        );
      });
      workers.push(worker);
      return worker as unknown as Worker;
    };
    const results = await scanBrowserProjectFilesOffThread(
      [request("a.erb"), request("b.erb")],
      new Set(),
      undefined,
      factory,
    );
    expect(results.map((value) => value?.relative_path)).toEqual(["a.erb", "b.erb"]);
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it("does not retry a source decoding error on the main thread", async () => {
    const source = request("bad.erb");
    const factory = () =>
      new FakeWorker((worker, message) =>
        worker.respond({ id: message.id, ok: false, error: "bad source" }),
      ) as unknown as Worker;
    await expect(
      scanBrowserProjectFilesOffThread([source], new Set(), undefined, factory),
    ).rejects.toThrow("bad source");
    expect(source.read).not.toHaveBeenCalled();
  });

  it("cleans a partially constructed pool and falls back after infrastructure failure", async () => {
    const first = new FakeWorker(() => undefined);
    let constructions = 0;
    const factory = () => {
      constructions += 1;
      if (constructions === 2) throw new Error("worker unavailable");
      return first as unknown as Worker;
    };
    const inputs = [
      request(
        "a.erb",
        vi.fn(async () => new TextEncoder().encode("@A").buffer),
      ),
      request(
        "b.erb",
        vi.fn(async () => new TextEncoder().encode("@B").buffer),
      ),
    ];
    const results = await scanBrowserProjectFilesOffThread(inputs, new Set(), undefined, factory);
    expect(results.map((value) => value?.relative_path)).toEqual(["a.erb", "b.erb"]);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(inputs.every((input) => input.read.mock.calls.length === 1)).toBe(true);
  });

  it("falls back on malformed responses and terminates every worker", async () => {
    const workers: FakeWorker[] = [];
    const factory = () => {
      const worker = new FakeWorker((self) => self.respond({ unexpected: true }));
      workers.push(worker);
      return worker as unknown as Worker;
    };
    const source = request(
      "a.erb",
      vi.fn(async () => new TextEncoder().encode("@A").buffer),
    );
    await expect(
      scanBrowserProjectFilesOffThread([source], new Set(), undefined, factory),
    ).resolves.toHaveLength(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it.each(["error", "messageerror"] as const)(
    "falls back after a worker %s event without leaving a pending request",
    async (eventType) => {
      const source = request(
        "a.erb",
        vi.fn(async () => new TextEncoder().encode("@A").buffer),
      );
      const worker = new FakeWorker((self) => {
        if (eventType === "error") {
          self.onerror?.({ message: "crashed", preventDefault: vi.fn() } as unknown as ErrorEvent);
        } else {
          self.onmessageerror?.({ data: null } as MessageEvent);
        }
      });
      await expect(
        scanBrowserProjectFilesOffThread(
          [source],
          new Set(),
          undefined,
          () => worker as unknown as Worker,
        ),
      ).resolves.toHaveLength(1);
      expect(source.read).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("aborts pending work without main-thread fallback", async () => {
    const controller = new AbortController();
    const source = request("a.erb");
    const worker = new FakeWorker(() => controller.abort());
    await expect(
      scanBrowserProjectFilesOffThread(
        [source],
        new Set(),
        controller.signal,
        () => worker as unknown as Worker,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(source.read).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
