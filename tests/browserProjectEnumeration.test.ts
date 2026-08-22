import { afterEach, describe, expect, it, vi } from "vitest";

import { enumerateBrowserProject } from "@/platform/browserProjectEnumeration";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("browser project enumeration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports every 32 visited entries and the final partial batch", async () => {
    const entries = Array.from({ length: 34 }, (_, index) => {
      const name = `source-${index.toString().padStart(2, "0")}.erb`;
      return [name, { kind: "file", name }] as const;
    });
    const root = {
      async *entries() {
        yield* entries;
      },
    } as unknown as FileSystemDirectoryHandle;
    const progress = vi.fn();

    const result = await enumerateBrowserProject(root, progress);

    expect(result.files).toHaveLength(34);
    expect(progress.mock.calls).toEqual([[32], [34]]);
  });

  it("overlaps Android Chromium subdirectory providers without changing classification", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 17; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
    });
    let active = 0;
    let maximumActive = 0;
    const directory = (index: number) => ({
      kind: "directory" as const,
      name: `ERB-${index}`,
      async *entries() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        yield [
          `source-${index}.erb`,
          { kind: "file" as const, name: `source-${index}.erb` },
        ] as const;
        active -= 1;
      },
    });
    const root = {
      async *entries() {
        for (let index = 0; index < 10; index += 1) {
          yield [`ERB-${index}`, directory(index)] as const;
        }
      },
    } as unknown as FileSystemDirectoryHandle;

    const result = await enumerateBrowserProject(root);

    expect(maximumActive).toBe(8);
    expect(result.files).toHaveLength(10);
    expect(result.files.every((file) => file.category === "erb")).toBe(true);
  });

  it("keeps the Apple directory traversal sequential", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    });
    let active = 0;
    let maximumActive = 0;
    const root = {
      async *entries() {
        for (let index = 0; index < 3; index += 1) {
          yield [
            `folder-${index}`,
            {
              kind: "directory" as const,
              name: `folder-${index}`,
              async *entries() {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await Promise.resolve();
                yield [`source-${index}.erb`, { kind: "file" as const }] as const;
                active -= 1;
              },
            },
          ] as const;
        }
      },
    } as unknown as FileSystemDirectoryHandle;

    await enumerateBrowserProject(root);

    expect(maximumActive).toBe(1);
  });

  it("preserves top-level classification, private exclusions, and NFC paths", async () => {
    const file = (name: string) => ({ kind: "file" as const, name });
    const directory = (name: string, entries: ReadonlyArray<readonly [string, object]>) => ({
      kind: "directory" as const,
      name,
      async *entries() {
        yield* entries;
      },
    });
    const nestedPrivate = directory(".rustyera", [["hidden.erb", file("hidden.erb")]]);
    const erb = directory("ErB", [
      ["e\u0301.erb", file("e\u0301.erb")],
      [".rustyera", nestedPrivate],
    ]);
    const misc = directory("misc", [["loose.erb", file("loose.erb")]]);
    const rootPrivate = directory(".RUSTYERA", [["root-hidden.erb", file("root-hidden.erb")]]);
    const root = directory("game", [
      ["ErB", erb],
      ["misc", misc],
      ["loose.erb", file("loose.erb")],
      [".RUSTYERA", rootPrivate],
    ]);

    const result = await enumerateBrowserProject(root as unknown as FileSystemDirectoryHandle);

    expect(result.topLevel).toEqual(new Set(["erb", "misc"]));
    expect(result.files.map((entry) => [entry.relativePath, entry.category])).toEqual([
      ["ErB/é.erb", "erb"],
    ]);
  });

  it("waits for active provider reads after the first failure and does not schedule children", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 17; K) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36",
    });
    const releaseSlow = deferred<void>();
    const slowStarted = deferred<void>();
    const failure = new Error("provider failed");
    let childStarted = 0;
    const child = {
      kind: "directory" as const,
      name: "child",
      async *entries() {
        childStarted += 1;
        yield* [];
      },
    };
    const failing = {
      kind: "directory" as const,
      name: "failing",
      async *entries(): AsyncIterableIterator<never> {
        await slowStarted.promise;
        yield await Promise.reject(failure);
      },
    };
    const slow = {
      kind: "directory" as const,
      name: "slow",
      async *entries() {
        slowStarted.resolve();
        await releaseSlow.promise;
        yield ["child", child] as const;
      },
    };
    const root = {
      async *entries() {
        yield ["failing", failing] as const;
        yield ["slow", slow] as const;
      },
    } as unknown as FileSystemDirectoryHandle;
    let settled = false;

    const enumeration = enumerateBrowserProject(root).finally(() => {
      settled = true;
    });
    await slowStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSlow.resolve();

    await expect(enumeration).rejects.toBe(failure);
    expect(childStarted).toBe(0);
  });
});
