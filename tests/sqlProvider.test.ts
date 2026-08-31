import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SQL_LIMITS,
  SQL_SQLITE_VERSION,
  bytesHex,
  encodeSqlResponse,
  sha256Bytes,
} from "@/core/sqlProtocol";
import { SqlProvider } from "@/platform/sqlProvider";

const providerHandle = new Map<number, unknown>([
  [0, 4n],
  [1, 1n],
]);
const connectionHandle = new Map<number, unknown>([
  [0, 4n],
  [1, 9n],
]);
const limits = new Map<number, unknown>(
  Object.values(SQL_LIMITS).map((value, index): [number, unknown] => [index, value]),
);

class ProviderWorkerStub {
  static instance?: ProviderWorkerStub;
  static readonly instances: ProviderWorkerStub[] = [];
  static crashNext = false;
  static holdNext = false;
  static validationErrorNext: string | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: any[] = [];
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    ProviderWorkerStub.instance = this;
    ProviderWorkerStub.instances.push(this);
  }

  postMessage(message: any): void {
    this.messages.push(message);
    if (ProviderWorkerStub.holdNext) {
      ProviderWorkerStub.holdNext = false;
      return;
    }
    queueMicrotask(() => {
      if (ProviderWorkerStub.crashNext) {
        ProviderWorkerStub.crashNext = false;
        this.onerror?.({ message: "SQL Worker crashed" } as ErrorEvent);
        return;
      }
      if (message.type === "settle") {
        this.onmessage?.({
          data: {
            id: message.id,
            type: "settled",
            result: {
              connection: { serviceEpoch: 4n, id: 9n },
              connected: true,
              transactionActive: false,
            },
          },
        } as MessageEvent);
        return;
      }
      if (message.type === "validate") {
        const error = ProviderWorkerStub.validationErrorNext;
        ProviderWorkerStub.validationErrorNext = undefined;
        this.onmessage?.({
          data: error
            ? { id: message.id, type: "error", error }
            : { id: message.id, type: "validated", result: null },
        } as MessageEvent);
        return;
      }
      const request = message.value.request;
      const operation = request.operation;
      const response =
        operation.kind === "open"
          ? encodeSqlResponse({
              provider: request.provider,
              database: {
                connection: operation.connection,
                connected: true,
                transactionActive: false,
                durableRevision: message.value.durableRevision,
              },
              result: [0, [SQL_SQLITE_VERSION, limits]],
            })
          : encodeSqlResponse({
              provider: request.provider,
              database: {
                connection: operation.connection,
                connected: true,
                transactionActive: false,
                durableRevision: message.value.expectedRevision,
              },
              result: [1, [1n]],
            });
      const publication = operation.kind === "execute" ? ProviderBridge.nextPublication : undefined;
      this.onmessage?.({
        data: { id: message.id, type: "executed", result: { response, publication } },
      } as MessageEvent);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class ProviderBridge {
  static nextPublication: any;
  readonly files = new Map<string, Uint8Array>();
  omitNextCurrentRevision = false;

  constructor(readonly seed: Uint8Array) {}

  async readResource(path: string): Promise<Uint8Array> {
    if (path !== "plugins/qol_data.db") throw new Error("not found");
    return this.seed.slice();
  }

  async handleStorage(request: any): Promise<any> {
    const current = this.files.get(request.relative_path);
    if (request.operation.type === "read")
      return current
        ? { result: { type: "read", data: current.slice(), revision: digest(current) } }
        : { result: { type: "error", error: { kind: "not_found" } } };
    if (request.operation.type === "list") {
      const prefix = `${request.relative_path}/`;
      return {
        result: {
          type: "listed",
          entries: [...this.files]
            .filter(([path]) => path.startsWith(prefix))
            .map(([relative_path, bytes]) => ({ relative_path, byte_length: bytes.byteLength })),
        },
      };
    }
    const precondition = request.operation.precondition;
    if (
      (precondition.type === "missing" && current) ||
      (precondition.type === "revision" && (!current || digest(current) !== precondition.revision))
    )
      return { result: { type: "error", error: { kind: "conflict" } } };
    const bytes = new Uint8Array(request.operation.data);
    this.files.set(request.relative_path, bytes);
    if (this.omitNextCurrentRevision && request.relative_path.endsWith("/current")) {
      this.omitNextCurrentRevision = false;
      return { result: { type: "written", revision: null } };
    }
    return { result: { type: "written", revision: digest(bytes) } };
  }
}

afterEach(() => {
  ProviderWorkerStub.instance = undefined;
  ProviderWorkerStub.instances.length = 0;
  ProviderWorkerStub.crashNext = false;
  ProviderWorkerStub.holdNext = false;
  ProviderWorkerStub.validationErrorNext = undefined;
  ProviderBridge.nextPublication = undefined;
  vi.unstubAllGlobals();
});

describe("SQL Worker provider", () => {
  it("uses one Worker path and acknowledges a revision only after current is published", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const seed = new TextEncoder().encode("seed database");
    const bridge = new ProviderBridge(seed);
    const provider = new SqlProvider(bridge as never);
    const signal = new AbortController().signal;

    await provider.handle(openRequest(seed), signal);
    const worker = ProviderWorkerStub.instance!;
    expect(String(worker.url)).toContain("sql.worker.ts");
    expect(worker.options).toEqual({ type: "module" });

    const next = new TextEncoder().encode("published database");
    const nextRevision = sha256Bytes(next);
    ProviderBridge.nextPublication = {
      token: 1,
      connection: { serviceEpoch: 4n, id: 9n },
      expectedRevision: sha256Bytes(seed),
      revision: nextRevision,
      bytes: next,
    };
    const response = await provider.handle(executeRequest(), signal);

    const settle = worker.messages.at(-1);
    expect(settle).toMatchObject({ type: "settle", value: { token: 1, accepted: true } });
    const current = [...bridge.files].find(([path]) => path.endsWith("/current"))?.[1];
    expect(new TextDecoder().decode(current)).toBe(`${bytesHex(nextRevision)}\n`);
    expect(
      ((response.get(1) as Map<number, unknown>).get(3) as Map<number, Uint8Array>).get(0),
    ).toEqual(nextRevision);
  });

  it("rejects an invalid Resource seed before durable storage is created", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    ProviderWorkerStub.validationErrorNext = "file is not a database";
    const seed = new TextEncoder().encode("not SQLite");
    const bridge = new ProviderBridge(seed);
    const provider = new SqlProvider(bridge as never);

    const response = await provider.handle(openRequest(seed), new AbortController().signal);

    expect(sqlErrorCode(response)).toBe(2);
    expect(bridge.files.size).toBe(0);
    expect(ProviderWorkerStub.instance?.messages.map((message) => message.type)).toEqual([
      "validate",
    ]);
  });

  it("terminates the Worker when its provider epoch is reset", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);
    await provider.handle(memoryOpenRequest(), new AbortController().signal);
    const worker = ProviderWorkerStub.instance!;

    provider.reset();

    expect(worker.terminated).toBe(true);
  });

  it("publishes and exactly reopens a memory database revision", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const bridge = new ProviderBridge(new Uint8Array());
    const provider = new SqlProvider(bridge as never);
    const signal = new AbortController().signal;
    await provider.handle(memoryOpenRequest(), signal);
    const bytes = new TextEncoder().encode("memory database revision");
    const revision = sha256Bytes(bytes);
    ProviderBridge.nextPublication = {
      token: 7,
      connection: { serviceEpoch: 4n, id: 9n },
      revision,
      bytes,
    };

    const response = await provider.handle(executeRequest(), signal);

    expect(
      ((response.get(1) as Map<number, unknown>).get(3) as Map<number, Uint8Array>).get(0),
    ).toEqual(revision);
    expect([...bridge.files.keys()].some((path) => path.endsWith("/current"))).toBe(false);

    provider.reset();
    await provider.handle(memoryOpenRequest(5n, revision), signal);
    const exact = ProviderWorkerStub.instance!.messages.at(-1).value;
    expect(exact).toMatchObject({ persistent: true });
    expect(bytesHex(exact.initialBytes)).toBe(bytesHex(bytes));
    expect(bytesHex(exact.durableRevision)).toBe(bytesHex(revision));
  });

  it("does not send rollback after current committed but its response metadata failed", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const seed = new TextEncoder().encode("seed database");
    const bridge = new ProviderBridge(seed);
    const provider = new SqlProvider(bridge as never);
    const signal = new AbortController().signal;
    await provider.handle(openRequest(seed), signal);
    const worker = ProviderWorkerStub.instance!;
    const next = new TextEncoder().encode("committed database");
    ProviderBridge.nextPublication = {
      token: 2,
      connection: { serviceEpoch: 4n, id: 9n },
      expectedRevision: sha256Bytes(seed),
      revision: sha256Bytes(next),
      bytes: next,
    };
    bridge.omitNextCurrentRevision = true;

    const response = await provider.handle(executeRequest(), signal);

    expect(sqlErrorCode(response)).toBe(23);
    expect(
      worker.messages.some(
        (message) => message.type === "settle" && message.value.accepted === false,
      ),
    ).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it("turns a Worker crash into a structured failure and terminates the crashed Worker", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    ProviderWorkerStub.crashNext = true;
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);

    const response = await provider.handle(memoryOpenRequest(), new AbortController().signal);

    expect(sqlErrorCode(response)).toBe(28);
    expect(ProviderWorkerStub.instance?.terminated).toBe(true);
  });

  it("terminates an executing Worker when cancellation wins", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    ProviderWorkerStub.holdNext = true;
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);
    const controller = new AbortController();
    const opening = provider.handle(memoryOpenRequest(), controller.signal);

    await Promise.resolve();
    controller.abort();

    await expect(opening).rejects.toThrow("cancelled");
    expect(ProviderWorkerStub.instance?.terminated).toBe(true);
  });

  it("rejects an old SQL service epoch without coupling it to runtime lifecycle epochs", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);
    await provider.handle(memoryOpenRequest(5n), new AbortController().signal);
    const worker = ProviderWorkerStub.instance!;

    const response = await provider.handle(memoryOpenRequest(4n), new AbortController().signal);

    expect(sqlErrorCode(response)).toBe(26);
    expect(worker.terminated).toBe(false);
  });

  it("creates a fresh Worker after an explicit project lifecycle reset", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);
    await provider.handle(memoryOpenRequest(4n), new AbortController().signal);
    const first = ProviderWorkerStub.instance!;

    provider.reset();
    await provider.handle(memoryOpenRequest(5n), new AbortController().signal);

    expect(first.terminated).toBe(true);
    expect(ProviderWorkerStub.instances).toHaveLength(2);
    expect(ProviderWorkerStub.instance).not.toBe(first);
  });

  it("rejects provider-boundary SQL quota excess before posting it to the Worker", async () => {
    vi.stubGlobal("Worker", ProviderWorkerStub);
    const provider = new SqlProvider(new ProviderBridge(new Uint8Array()) as never);

    const response = await provider.handle(
      executeRequest("x".repeat(SQL_LIMITS.maximumSqlBytes + 1)),
      new AbortController().signal,
    );

    expect(sqlErrorCode(response)).toBe(11);
    expect(ProviderWorkerStub.instance?.messages).toHaveLength(0);
  });
});

function openRequest(seed: Uint8Array): Map<number, unknown> {
  return new Map<number, unknown>([
    [0, providerHandle],
    [
      1,
      [
        0,
        [
          connectionHandle,
          "main",
          new Map<number, unknown>([
            [
              0,
              [
                1,
                [
                  new Map<number, unknown>([
                    [0, "plugins/qol_data.db"],
                    [1, sha256Bytes(seed)],
                  ]),
                ],
              ],
            ],
            [1, SQL_SQLITE_VERSION],
            [2, 1],
          ]),
          [0, []],
          limits,
        ],
      ],
    ],
  ]);
}

function memoryOpenRequest(epoch = 4n, exactRevision?: Uint8Array): Map<number, unknown> {
  const provider = new Map<number, unknown>([
    [0, epoch],
    [1, 1n],
  ]);
  const connection = new Map<number, unknown>([
    [0, epoch],
    [1, 9n],
  ]);
  return new Map<number, unknown>([
    [0, provider],
    [
      1,
      [
        0,
        [
          connection,
          "memory",
          new Map<number, unknown>([
            [0, [0, []]],
            [1, SQL_SQLITE_VERSION],
            [2, 1],
          ]),
          exactRevision ? [1, [new Map<number, unknown>([[0, exactRevision]])]] : [0, []],
          limits,
        ],
      ],
    ],
  ]);
}

function executeRequest(sql = "INSERT INTO t VALUES (1)"): Map<number, unknown> {
  return new Map<number, unknown>([
    [0, providerHandle],
    [1, [1, [connectionHandle, 0, sql, []]]],
  ]);
}

function digest(bytes: Uint8Array): string {
  return bytesHex(sha256Bytes(bytes));
}

function sqlErrorCode(response: Map<number, unknown>): number | undefined {
  const result = response.get(3);
  if (!Array.isArray(result) || result[0] !== 10 || !Array.isArray(result[1])) return undefined;
  const error = result[1][0];
  return error instanceof Map ? error.get(0) : undefined;
}
