import { describe, expect, it } from "vitest";

import { assistedInteractionRows, interactionAssistModeVisible } from "@/core/interactionAssist";

describe("interaction assistance projection", () => {
  it("collects enabled interactions by compact source row with accessible label fallbacks", () => {
    const rows = assistedInteractionRows({
      lines: [
        { line_id: 1, runs: [{ type: "text", text: "no action" }] },
        {
          line_id: 2,
          runs: [
            {
              type: "button",
              enabled: true,
              token: { epoch: 4, id: 1 },
              runs: [{ type: "text", text: "  first\nchoice  " }],
            },
            {
              type: "column_cell",
              content: [
                {
                  type: "button",
                  enabled: false,
                  token: { epoch: 4, id: 2 },
                  runs: [{ type: "text", text: "disabled" }],
                },
                {
                  type: "button",
                  enabled: true,
                  token: { epoch: 4, id: 3 },
                  runs: [
                    {
                      type: "image",
                      alt_text: "portrait",
                      placement: { resource_id: "resources/portrait.png" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      htmlIsland: [
        {
          nodes: [
            {
              type: "element",
              kind: "button",
              interaction: { epoch: 4, id: 4, enabled: true },
              semantic: { type: "button", title: "map tooltip" },
              children: [
                {
                  type: "element",
                  semantic: { type: "image", source: "resources/map.png" },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    } as any);

    expect(rows).toEqual([
      {
        rowKey: "line:2",
        items: [
          { key: "4:1", label: "first choice", token: { epoch: 4, id: 1 } },
          { key: "4:3", label: "portrait", token: { epoch: 4, id: 3 } },
        ],
      },
      {
        rowKey: "island:0",
        items: [{ key: "4:4", label: "map tooltip", token: { epoch: 4, id: 4 } }],
      },
    ]);
  });

  it("deduplicates tokens and falls back to a resource path or generic label", () => {
    const rows = assistedInteractionRows({
      lines: [
        {
          line_id: 1,
          runs: [
            {
              type: "button",
              enabled: true,
              token: { epoch: 2, id: 7 },
              runs: [{ type: "image", placement: { resource_id: "button.png" } }],
            },
            {
              type: "button",
              enabled: true,
              token: { epoch: 2, id: 7 },
              runs: [{ type: "text", text: "duplicate" }],
            },
            { type: "button", enabled: true, token: { epoch: 2, id: 8 }, runs: [] },
          ],
        },
      ],
      htmlIsland: [],
    } as any);

    expect(rows[0].items.map((item) => item.label)).toEqual(["button.png", "未命名交互项"]);
  });

  it("projects non-default text colors from run and inherited HTML styles", () => {
    const rows = assistedInteractionRows({
      lines: [
        {
          line_id: 5,
          runs: [
            {
              type: "button",
              enabled: true,
              token: { epoch: 3, id: 1 },
              runs: [
                {
                  type: "text",
                  text: "default ",
                  style: { foreground: { red: 192, green: 192, blue: 192, alpha: 255 } },
                },
                {
                  type: "text",
                  text: "accent",
                  style: { foreground: { red: 12, green: 34, blue: 56, alpha: 255 } },
                },
                {
                  type: "text",
                  text: " then another",
                  style: { foreground: { red: 90, green: 80, blue: 70, alpha: 255 } },
                },
              ],
            },
          ],
        },
      ],
      htmlIsland: [
        {
          nodes: [
            {
              type: "element",
              kind: "font",
              semantic: { type: "font", color: 0x654321 },
              children: [
                {
                  type: "element",
                  kind: "button",
                  interaction: { epoch: 3, id: 2, enabled: true },
                  semantic: { type: "button" },
                  children: [{ type: "text", text: "inherited" }],
                },
                {
                  type: "element",
                  kind: "button",
                  interaction: { epoch: 3, id: 3, enabled: true },
                  semantic: { type: "button" },
                  children: [
                    {
                      type: "element",
                      kind: "font",
                      semantic: { type: "font", color: 0x112233 },
                      children: [{ type: "text", text: "overridden" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as any);

    expect(rows).toEqual([
      {
        rowKey: "line:5",
        items: [
          {
            key: "3:1",
            label: "default accent then another",
            token: { epoch: 3, id: 1 },
            color: "rgba(12, 34, 56, 1)",
          },
        ],
      },
      {
        rowKey: "island:0",
        items: [
          {
            key: "3:2",
            label: "inherited",
            token: { epoch: 3, id: 2 },
            color: "rgb(101, 67, 33)",
          },
          {
            key: "3:3",
            label: "overridden",
            token: { epoch: 3, id: 3 },
            color: "rgb(17, 34, 51)",
          },
        ],
      },
    ]);
  });

  it("resolves automatic visibility only for mobile browsers", () => {
    expect(interactionAssistModeVisible("off", "browser", true)).toBe(false);
    expect(interactionAssistModeVisible("on", "tauri", false)).toBe(true);
    expect(interactionAssistModeVisible("auto", "browser", true)).toBe(true);
    expect(interactionAssistModeVisible("auto", "browser", false)).toBe(false);
    expect(interactionAssistModeVisible("auto", "tauri", true)).toBe(false);
  });
});
