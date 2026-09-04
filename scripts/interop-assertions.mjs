/* global window -- Only referenced by callbacks serialized into the test WebView. */
import assert from "node:assert/strict";

export function validateExpectedValues(values) {
  assert.ok(
    values && typeof values === "object" && !Array.isArray(values),
    "expected watches must be an object",
  );
  assert.ok(Object.keys(values).length, "expected watches must not be empty");
  for (const [name, value] of Object.entries(values)) {
    assert.ok(
      name && value && ["integer", "string"].includes(value.type),
      `invalid expected watch: ${name}`,
    );
    assert.equal(typeof value.value, "string", `${name}: expected value must be a string`);
    if (value.type === "integer") assert.match(value.value, /^-?\d+$/, `${name}: invalid integer`);
  }
  return values;
}

export function typedValues(typed, watches) {
  assert.equal(typed?.version, 1, "typed response version");
  return Object.fromEntries(
    watches.map((name) => {
      const entry = typed.values?.[name];
      assert.equal(entry?.present, true, `${name}: typed value unavailable`);
      const value = entry.value;
      assert.ok(value && ["integer", "string"].includes(value.type), `${name}: invalid value type`);
      if (value.type === "string") assert.equal(typeof value.value, "string");
      else {
        assert.ok(
          typeof value.value === "string" || Number.isSafeInteger(value.value),
          `${name}: invalid integer`,
        );
        assert.match(String(value.value), /^-?\d+$/);
      }
      return [name, { type: value.type, value: String(value.value) }];
    }),
  );
}

function responseFor(records, request) {
  assert.notEqual(request.message.value.request_id, undefined, "storage request ID missing");
  if (request.nativeResponse) {
    assert.ok(request.nativeContext?.process_id, "native storage process identity missing");
    assert.equal(
      String(request.nativeResponse.request_id),
      String(request.message.value.request_id),
      "native storage response ID mismatch",
    );
    return request.nativeResponse.result;
  }
  assert.notEqual(request.epoch, undefined, "storage request epoch missing");
  assert.notEqual(request.sessionGeneration, undefined, "storage request session missing");
  const responses = records.filter(
    (record) =>
      record.message?.type === "storage_response" &&
      record.sessionGeneration === request.sessionGeneration &&
      String(record.epoch) === String(request.epoch) &&
      String(record.message.value.request_id) === String(request.message.value.request_id),
  );
  assert.equal(responses.length, 1, "storage request needs exactly one matching response");
  return responses[0].message.value.result;
}

// Native storage is completed inside the Rust host, before a Vue event exists.
// Retain its actual request/response pair and host context; do not invent wire epochs.
export function nativeStorageCapture(text, project) {
  assert.ok(text.endsWith("\n"), "native storage capture is incomplete");
  const entries = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(entries.length, "native storage capture is empty");
  let processId;
  const records = entries.map((entry, index) => {
    assert.equal(entry.version, 1, "native storage capture version");
    assert.equal(entry.failure, undefined, "native storage capture failed");
    assert.equal(entry.source, "native_storage_host");
    assert.equal(entry.sequence, index, "native storage sequence gap");
    assert.equal(entry.context?.project_root, project, "native storage project differs");
    assert.equal(entry.context?.save_root, project, "native storage sav root differs");
    processId ??= entry.context.process_id;
    assert.equal(entry.context.process_id, processId, "native storage process changed");
    assert.ok(Number.isSafeInteger(processId) && processId > 0, "native process ID missing");
    assert.match(entry.request?.request_id ?? "", /^\d+$/, "native storage request ID missing");
    assert.equal(
      entry.response?.request_id,
      entry.request.request_id,
      "native storage response ID mismatch",
    );
    assert.ok(entry.response.result?.type, "native storage result missing");
    return {
      index,
      nativeContext: entry.context,
      message: { type: "storage_request", value: entry.request },
      nativeResponse: entry.response,
    };
  });
  return {
    version: 1,
    source: "native_storage_host",
    enabled: true,
    overflow: false,
    failure: null,
    records,
  };
}

export function assertProjectStorage(storage) {
  assert.equal(storage?.enabled, true, "storage capture must be enabled");
  assert.equal(storage.overflow, false, "storage capture overflowed");
  assert.equal(storage.failure, null, "storage capture failed");
  assert.ok(Array.isArray(storage.records), "storage records missing");
  const requests = storage.records.filter((record) => record.message?.type === "storage_request");
  for (const {
    message: { value: request },
  } of requests) {
    assert.ok(
      ["project", "save", "global_save", "data", "log", "resource"].includes(request.namespace),
      `unexpected namespace: ${request.namespace}`,
    );
    const relative = String(request.relative_path).replaceAll("\\", "/");
    assert.ok(
      !/(?:^|\/)(?:\.rustyera\/)?profiles\/[^/]+\/(?:sav|save)(?:\/|$)/i.test(relative),
      "private profile save path requested",
    );
    if (["save", "global_save"].includes(request.namespace))
      assert.ok(
        !/(?:^|\/)(?:\.rustyera|profiles)(?:\/|$)/i.test(relative),
        "private save path requested",
      );
  }
  const reads = requests.filter(
    ({ message: { value: request } }) =>
      request.namespace === "global_save" &&
      request.relative_path === "global.sav" &&
      ["read", "read_range"].includes(request.operation.type),
  );
  assert.ok(reads.length, "GLOBAL must be read from project storage");
  for (const request of reads)
    assert.ok(
      ["read", "read_chunk"].includes(responseFor(storage.records, request)?.type),
      "GLOBAL read did not succeed",
    );
}

export function assertSuccessfulWrites(records) {
  for (const [namespace, filename] of [
    ["save", "save1000.sav"],
    ["global_save", "global.sav"],
  ]) {
    const writes = records.filter(
      ({ message }) =>
        message?.type === "storage_request" &&
        message.value.namespace === namespace &&
        message.value.relative_path === filename &&
        message.value.operation.type === "write",
    );
    assert.ok(writes.length, `${filename}: visible save must request a write`);
    for (const request of writes) {
      assert.equal(
        request.message.value.operation.atomic_replace,
        true,
        `${filename}: atomic save`,
      );
      assert.equal(
        responseFor(records, request)?.type,
        "written",
        `${filename}: acknowledged write`,
      );
    }
  }
}

export async function inspectWebdriverTyped(browser, watches) {
  // A real TW symbol walk spans many debug replies. Keep each WebDriver HTTP
  // request short so the independent complete-snapshot watchdog stays responsive.
  // Real TW expands character descriptors across many pages. The five-second
  // watchdog and each debug request still fail promptly if that walk stops advancing.
  await browser.execute((names) => {
    const pending = { status: "pending" };
    window.__RUSTYERA_INTEROP_INSPECTION__ = pending;
    void window.__RUSTYERA_TEST__.inspectTyped(names).then(
      (value) => Object.assign(pending, { status: "completed", value }),
      (error) => Object.assign(pending, { status: "failed", error: String(error) }),
    );
  }, watches);
  await browser.waitUntil(
    () => browser.execute(() => window.__RUSTYERA_INTEROP_INSPECTION__?.status !== "pending"),
    { timeout: 300_000, interval: 100, timeoutMsg: "typed debug inspection did not complete" },
  );
  const result = await browser.execute(() => {
    const result = window.__RUSTYERA_INTEROP_INSPECTION__;
    delete window.__RUSTYERA_INTEROP_INSPECTION__;
    return result;
  });
  assert.equal(result?.status, "completed", result?.error ?? "typed inspection result missing");
  return result.value;
}
