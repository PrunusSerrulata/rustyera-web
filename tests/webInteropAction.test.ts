import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runAction } from "../scripts/web-test-lib.mjs";

it("retains exact typed character values before reporting an interop mismatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rustyera-interop-action-"));
  const evidence = path.join(directory, "actual.json");
  const typed = {
    version: 1,
    values: { "NO@0": { present: true, value: { type: "integer", value: "9007199254740993" } } },
  };
  const protocolEvidence = vi.fn(() => ({
    enabled: true,
    overflow: false,
    failure: null,
    records: [],
  }));
  vi.stubGlobal("window", {
    __RUSTYERA_TEST__: {
      inspectTyped: () => typed,
      snapshot: () => {
        throw new Error("unrelated protocol payload must not be serialized");
      },
      snapshotSummary: () => ({
        bridgeKind: "browser",
        fault: null,
      }),
      protocolEvidence,
    },
  });
  const page = {
    evaluate: vi.fn((callback, argument) => callback(argument)),
  };
  try {
    await expect(
      runAction(page, {
        type: "assert_interop",
        expect: { "NO@0": { type: "integer", value: "9007199254740992" } },
        evidence_path: evidence,
      }),
    ).rejects.toThrow();
    expect(page.evaluate.mock.calls[0]?.[1]).toEqual(["NO@0"]);
    expect(protocolEvidence).toHaveBeenCalledWith(["storage_request", "storage_response"]);
    expect(JSON.parse(await readFile(evidence, "utf8")).typed).toEqual(typed);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it("recognizes a loaded menu without decoding unrelated protocol evidence", async () => {
  vi.stubGlobal("window", {
    __RUSTYERA_TEST__: {
      snapshot: () => {
        throw new Error("unrelated protocol payload must not be serialized");
      },
      snapshotSummary: () => ({ output: ["【主菜单】"], wait: { kind: "integer_value" } }),
    },
  });
  const page = {
    evaluate: vi.fn((callback) => callback()),
    locator: vi.fn(),
    waitForFunction: vi.fn(),
  };
  try {
    await expect(
      runAction(page, {
        type: "advance_enter_waits_until",
        maximum: 16,
        until: { output_tail_contains: "【主菜单】" },
      }),
    ).resolves.toEqual({ semanticInput: "", attempts: 0 });
    expect(page.locator).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects missing interop expectations before reading or changing the client", async () => {
  const page = { evaluate: vi.fn() };
  await expect(runAction(page, { type: "assert_interop", expect: {} })).rejects.toThrow();
  expect(page.evaluate).not.toHaveBeenCalled();
});
