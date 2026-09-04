import { expect, it } from "vitest";
import {
  assertProjectStorage,
  assertSuccessfulWrites,
  nativeStorageCapture,
  typedValues,
  validateExpectedValues,
} from "../scripts/interop-assertions.mjs";

it.each([null, false, 0, "", {}, [], { MONEY: { type: "float", value: "1" } }])(
  "rejects unusable expected state %j",
  (value) => {
    expect(() => validateExpectedValues(value)).toThrow();
  },
);

it("rejects missing or ill-typed actual values", () => {
  expect(() => typedValues({ version: 1, values: {} }, ["MONEY"])).toThrow();
  expect(() =>
    typedValues(
      { version: 1, values: { MONEY: { present: true, value: { type: "integer", value: true } } } },
      ["MONEY"],
    ),
  ).toThrow();
  expect(
    typedValues(
      {
        version: 1,
        values: { MONEY: { present: true, value: { type: "integer", value: "9007199254740993" } } },
      },
      ["MONEY"],
    ),
  ).toEqual({ MONEY: { type: "integer", value: "9007199254740993" } });
});

function capture() {
  return {
    enabled: true,
    overflow: false,
    failure: null,
    records: [
      {
        epoch: "7",
        sessionGeneration: 2,
        message: {
          type: "storage_request",
          value: {
            request_id: "9",
            namespace: "global_save",
            relative_path: "global.sav",
            operation: { type: "read" },
          },
        },
      },
      {
        epoch: "7",
        sessionGeneration: 2,
        message: { type: "storage_response", value: { request_id: "9", result: { type: "read" } } },
      },
    ],
  };
}

it("requires a successful GLOBAL response from the same epoch and session", () => {
  const storage = capture();
  expect(() => assertProjectStorage(storage)).not.toThrow();
  storage.records[1].epoch = "8";
  expect(() => assertProjectStorage(storage)).toThrow("matching response");
  storage.records[1].epoch = "7";
  storage.records[1].message.value.result = { type: "not_found" };
  expect(() => assertProjectStorage(storage)).toThrow("GLOBAL read did not succeed");
});

it("rejects private save fallback through a different namespace", () => {
  const storage = capture();
  storage.records[0].message.value.namespace = "project";
  storage.records[0].message.value.relative_path =
    ".rustyera/profiles/emuera.skia.snake/sav/save00.sav";
  expect(() => assertProjectStorage(storage)).toThrow("private profile save");
});

it("checks real native host pairs without manufacturing runtime epochs", () => {
  const row = (
    sequence: number,
    namespace: string,
    relative_path: string,
    type: string,
    result: string,
  ) => ({
    version: 1,
    source: "native_storage_host",
    sequence,
    context: { process_id: 42, project_root: "/isolated/game", save_root: "/isolated/game" },
    request: {
      request_id: String(sequence + 1),
      namespace,
      relative_path,
      operation: { type, atomic_replace: true },
    },
    response: { request_id: String(sequence + 1), result: { type: result } },
  });
  const rows = [
    row(0, "global_save", "global.sav", "read", "read"),
    row(1, "save", "save1000.sav", "write", "written"),
    row(2, "global_save", "global.sav", "write", "written"),
  ];
  const encode = (entries: any[]) =>
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const capture = nativeStorageCapture(encode(rows), "/isolated/game");
  expect(() => assertProjectStorage(capture)).not.toThrow();
  expect(() => assertSuccessfulWrites(capture.records.slice(1))).not.toThrow();
  expect(capture.records[0].epoch).toBeUndefined();
  expect(() => nativeStorageCapture(encode(rows), "/different/game")).toThrow();
  expect(() => nativeStorageCapture(encode([rows[1]]), "/isolated/game")).toThrow("sequence gap");
  expect(() =>
    nativeStorageCapture(
      encode([{ ...rows[0], response: { request_id: "99" } }]),
      "/isolated/game",
    ),
  ).toThrow("response ID mismatch");
  expect(() =>
    nativeStorageCapture(encode([{ version: 1, failure: "observation_limit" }]), "/isolated/game"),
  ).toThrow("capture failed");
  const failed = nativeStorageCapture(
    encode([
      rows[0],
      { ...rows[1], response: { request_id: "2", result: { type: "error" } } },
      rows[2],
    ]),
    "/isolated/game",
  );
  expect(() => assertSuccessfulWrites(failed.records.slice(1))).toThrow("acknowledged write");
});
