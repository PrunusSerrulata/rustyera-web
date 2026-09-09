import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebEvent } from "@/core/types";
import { RuntimeEvidence } from "@/testing/runtimeEvidence";

const presentationTypes = ["presentation_delta", "presentation_snapshot"] as const;
function evidence(compactPresentationOutput = false) {
  return new RuntimeEvidence(true, undefined, undefined, undefined, { compactPresentationOutput });
}
function event(message: unknown, sequence = 1, channel: "runtime" | "debug" = "runtime"): WebEvent {
  return {
    channel,
    sequence,
    messageId: BigInt(sequence + 100),
    correlationId: 90n,
    epoch: 7n,
    message,
  } as WebEvent;
}
function records(ledger: RuntimeEvidence, fromRecord = 0): any[] {
  return ledger.snapshot(3, undefined, fromRecord).records as any[];
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe("performance-only compact presentation output evidence", () => {
  it.each(presentationTypes)("never reads or enumerates %s payload", (type) => {
    const ledger = evidence(true);
    const accessed = vi.fn(() => {
      throw new Error("presentation value must not be read");
    });
    const message = {
      type,
      get value() {
        return accessed();
      },
    };
    const prepare = vi.spyOn(ledger, "prepareMessage");
    ledger.receive(event(message), 3);
    expect(accessed).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(ledger.summary().failure).toBeNull();
    expect(records(ledger)).toEqual([
      {
        index: 0,
        direction: "receive",
        channel: "runtime",
        sequence: 1,
        messageId: "101",
        correlationId: "90",
        epoch: "7",
        sessionGeneration: 3,
        message: { type },
      },
    ]);
  });

  it.each(presentationTypes)("does not serialize %s message or traverse its value", (type) => {
    const forbidden = vi.fn(() => {
      throw new Error("payload serialization is forbidden");
    });
    const value = new Proxy({}, { get: forbidden, ownKeys: forbidden });
    const message = { type, value, toJSON: forbidden };
    const ledger = evidence(true);
    ledger.receive(event(message));
    expect(records(ledger)[0].message).toEqual({ type });
    expect(forbidden).not.toHaveBeenCalled();
    expect(ledger.summary().failure).toBeNull();
  });

  it.each(presentationTypes)("keeps ordinary %s output complete by default", (type) => {
    const ledger = new RuntimeEvidence(true);
    const message = { type, value: { revision: 9, lines: [{ text: "canonical presentation" }] } };
    ledger.receive(event(message));
    expect(records(ledger)[0].message).toEqual(message);
    const serialization = vi.fn(() => {
      throw new Error("ordinary evidence still serializes values");
    });
    ledger.receive(event({ type, value: { toJSON: serialization } }, 2));
    expect(serialization).toHaveBeenCalledOnce();
    expect(ledger.summary().failure).toBe("unserializable_observation");
  });

  it("preserves ordering, record cursors, tags and every other protocol payload", () => {
    const compact = evidence(true);
    const ordinary = evidence();
    for (const ledger of [compact, ordinary]) {
      ledger.sent(
        "runtime",
        { type: "client_hello", value: { features: ["sql"] } },
        1,
        7,
        undefined,
        3,
      );
      ledger.receive(event({ type: "presentation_delta", value: { revision: 1 } }, 2), 3);
      ledger.receive(
        event(
          {
            type: "service_request",
            value: { kind: "sql", request_id: 1, payload: { sql: "SELECT 1", parameters: [4] } },
          },
          3,
        ),
        3,
      );
      ledger.sent(
        "runtime",
        { type: "service_response", value: { request_id: 1, result: { value: 1 } } },
        4,
        7,
        103,
        3,
      );
      ledger.sent("runtime", { type: "input", value: { value: 805 } }, 5, 7, undefined, 3);
      ledger.receive(event({ type: "presentation_snapshot", value: { revision: 2 } }, 6), 3);
      ledger.receive(
        event(
          { type: "storage_request", value: { operation: { type: "read", path: "save.dat" } } },
          7,
        ),
        3,
      );
      ledger.sent(
        "runtime",
        { type: "storage_response", value: { result: { type: "read", data: [1, 2] } } },
        8,
        7,
        107,
        3,
      );
      ledger.receive(
        event({ type: "debug_output", value: { text: "debug evidence" } }, 9, "debug"),
        3,
      );
    }
    expect(compact.snapshot().recordCursor).toBe(9);
    expect(records(compact).map((row) => [row.index, row.direction, row.message.type])).toEqual(
      records(ordinary).map((row) => [row.index, row.direction, row.message.type]),
    );
    const expected = records(ordinary).map((row) =>
      presentationTypes.includes(row.message.type)
        ? { ...row, message: { type: row.message.type } }
        : row,
    );
    expect(records(compact)).toEqual(expected);
    expect(records(compact, 5)).toEqual(expected.slice(5));
    expect(compact.snapshot(3, new Set(presentationTypes), 2)).toMatchObject({
      recordCursor: 9,
      records: [expected[5]],
    });
  });

  it("does not compact sent presentation tags or received debug-channel messages", () => {
    const ledger = evidence(true);
    const message = { type: "presentation_delta", value: { keep: "full" } };
    ledger.sent("runtime", message, 1, 7);
    ledger.receive(event(message, 2, "debug"));
    expect(records(ledger).map((row) => row.message)).toEqual([message, message]);
  });

  it("preserves export-command evidence and filtering policy", () => {
    const compact = evidence(true);
    const ordinary = evidence();
    for (const ledger of [compact, ordinary]) {
      ledger.receive(event({ type: "presentation_delta", value: { revision: 1 } }));
      ledger.sent("runtime", { type: "state_export_request", value: { transfer_id: 9 } }, 2, 7);
      ledger.sent("runtime", { type: "state_export_cancel", value: { transfer_id: 9 } }, 3, 7);
    }
    const selection = new Set(["state_export_request", "state_export_cancel"]);
    expect(compact.snapshot(3, selection)).toEqual(ordinary.snapshot(3, selection));
    expect(compact.snapshot(3, selection).scope).toBe("export_commands");
    const selected = new RuntimeEvidence(true, undefined, undefined, new Set(["input"]), {
      compactPresentationOutput: true,
    });
    selected.receive(
      event({
        type: "presentation_delta",
        get value() {
          throw new Error("filtered value");
        },
      }),
    );
    expect(selected.snapshot().recordCursor).toBe(0);
  });
});
