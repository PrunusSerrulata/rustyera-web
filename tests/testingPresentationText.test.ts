import { describe, expect, it } from "vitest";
import { observedLineText } from "@/testing/presentationText";
import type { DisplayLine } from "@/core/types";

describe("canonical presentation text observations", () => {
  it("keeps nested HTML save buttons alongside ordinary text", () => {
    const line = {
      runs: [
        { type: "text", text: "slot: " },
        {
          type: "html_document",
          document: {
            nodes: [
              {
                type: "element",
                kind: "button",
                children: [
                  { type: "text", text: "[0] - " },
                  { type: "element", kind: "bold", children: [{ type: "text", text: "----" }] },
                ],
              },
              { type: "element", kind: "break" },
              { type: "text", text: "A&B" },
            ],
          },
        },
      ],
    } as DisplayLine;
    expect(observedLineText(line)).toBe("slot: [0] - ----\nA&B");
    expect(
      observedLineText({ runs: [{ type: "column_cell", content: line.runs }] } as DisplayLine),
    ).toBe("slot: [0] - ----\nA&B");
  });
});
