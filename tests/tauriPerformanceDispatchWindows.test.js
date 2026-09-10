import { expect, it } from "vitest";
import { validateDispatchWindows } from "../scripts/tauri-performance-dispatch-windows.mjs";

const windowProfile = () => ({
  active: false,
  startedAtDispatches: "0",
  endedAtDispatches: "2048",
  maximumLength: 8,
  maximumPatterns: 4096,
  incomplete: false,
  restartedWhileActive: false,
  opportunities: "2",
  startedWindows: "2",
  excludedContinuations: "0",
  droppedWindows: "0",
  counts: [{ opcodes: [0, 65535], termination: "action_end", samples: "2" }],
  pending: null,
});

it("preserves completed window counts without mutating the input", () => {
  const input = windowProfile();
  const before = structuredClone(input);
  expect(validateDispatchWindows(input, "2048")).toEqual(before);
  expect(validateDispatchWindows(input, "2048")).toEqual(before);
  expect(input).toEqual(before);
});

it("accounts for pending attempts and excluded continuations independently", () => {
  const input = windowProfile();
  input.active = true;
  input.startedWindows = "1";
  input.excludedContinuations = "1";
  input.counts = [];
  input.pending = { opcodes: [0, 1, 2, 3, 4, 5, 6] };
  expect(validateDispatchWindows(input, "2048")).toEqual(input);
});

it("validates sampling opportunities across a nonaligned action boundary", () => {
  const input = windowProfile();
  input.startedAtDispatches = "1023";
  input.endedAtDispatches = "2047";
  input.opportunities = "1";
  input.startedWindows = "1";
  input.counts[0].samples = "1";
  expect(validateDispatchWindows(input, "2048")).toEqual(input);
});

it.each([
  ["duplicate", (w) => w.counts.push(structuredClone(w.counts[0]))],
  ["negative opcode", (w) => (w.counts[0].opcodes = [-1])],
  ["large opcode", (w) => (w.counts[0].opcodes = [65536])],
  ["fractional opcode", (w) => (w.counts[0].opcodes = [0.5])],
  ["empty pattern", (w) => (w.counts[0].opcodes = [])],
  ["long pattern", (w) => (w.counts[0].opcodes = Array(9).fill(0))],
  ["wrong length_limit", (w) => (w.counts[0].termination = "length_limit")],
  ["unknown termination", (w) => (w.counts[0].termination = "success")],
  ["zero samples", (w) => (w.counts[0].samples = "0")],
  ["u64 overflow", (w) => (w.startedWindows = "18446744073709551616")],
  ["noncanonical u64", (w) => (w.startedWindows = "02")],
  ["opportunities", (w) => (w.opportunities = "3")],
  ["starts", (w) => (w.startedWindows = "3")],
  ["samples", (w) => (w.counts[0].samples = "1")],
  ["inactive pending", (w) => (w.pending = { opcodes: [0] })],
  [
    "full pending",
    (w) => {
      w.active = true;
      w.pending = { opcodes: Array(8).fill(0) };
    },
  ],
  [
    "stale active endpoint",
    (w) => {
      w.active = true;
      w.endedAtDispatches = "2047";
    },
  ],
  ["missing pending", (w) => delete w.pending],
  ["reverse bounds", (w) => (w.startedAtDispatches = "2049")],
  ["future bounds", (w) => (w.endedAtDispatches = "2049")],
  ["unmarked loss", (w) => (w.droppedWindows = "1")],
  ["unmarked restart", (w) => (w.restartedWhileActive = true)],
  ["maximum length", (w) => (w.maximumLength = 7)],
  ["maximum patterns", (w) => (w.maximumPatterns = 4095)],
  ["pattern cap", (w) => (w.counts = Array(4097).fill(w.counts[0]))],
])("rejects malformed dispatch windows: %s", (_name, change) => {
  const input = windowProfile();
  change(input);
  expect(() => validateDispatchWindows(input, "2048")).toThrow();
});

it.each([null, [], "window"])("rejects a nonobject window %j", (input) => {
  expect(() => validateDispatchWindows(input, "2048")).toThrow();
});

it("allows incomplete counters but still checks patterns and bounds", () => {
  const input = windowProfile();
  input.incomplete = true;
  input.restartedWhileActive = true;
  input.droppedWindows = "18446744073709551615";
  input.counts[0].termination = "overflow";
  expect(validateDispatchWindows(input, "2048")).toEqual(input);
  input.counts[0].opcodes = [65536];
  expect(() => validateDispatchWindows(input, "2048")).toThrow();
  input.counts[0].opcodes = [0];
  input.endedAtDispatches = "2049";
  expect(() => validateDispatchWindows(input, "2048")).toThrow();
});

it("accepts all bounded termination variants, including eight attempted opcodes", () => {
  for (const termination of [
    "length_limit",
    "discontinuous",
    "slice_boundary",
    "control_boundary",
    "diagnostic",
    "fault",
    "action_end",
    "overflow",
  ]) {
    const input = windowProfile();
    input.counts[0] = { opcodes: Array(8).fill(0), termination, samples: "2" };
    expect(validateDispatchWindows(input, "2048")).toEqual(input);
  }
});
