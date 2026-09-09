import { expect, it } from "vitest";
import { performancePresentationInventory } from "@/testing/performancePresentationInventory";

it("counts presentation metadata without inspecting encoded image bytes", () => {
  const encoded = new Proxy(
    { length: 5_000_000 },
    {
      get(target, key) {
        if (key !== "length") throw new Error("byte payload accessed");
        return target.length;
      },
    },
  );
  expect(
    performancePresentationInventory({
      resources: {
        sprites: [{ frames: [{}, {}] }],
        canvases: [{ commands: [{ type: "load_encoded_image", encoded }, { type: "clear" }] }],
      },
      lines: [],
      htmlIsland: [],
      scene: { layers: [] },
    }),
  ).toEqual({
    sprites: 1,
    spriteFrames: 2,
    canvases: 1,
    canvasCommands: 2,
    embeddedImageBytes: 5_000_000,
    lines: 0,
    htmlDocuments: 0,
    sceneLayers: 0,
    truncated: false,
  });
});

it("bounds metadata traversal", () => {
  const sprite = { frames: [] };
  const sprites = Array(100_001).fill(sprite);
  Object.defineProperty(sprites, 100_000, {
    get() {
      throw new Error("over budget element read");
    },
  });
  expect(
    performancePresentationInventory({
      resources: { sprites },
      lines: [],
      htmlIsland: [],
      scene: { layers: [] },
    }).truncated,
  ).toBe(true);
});

it.each(["sprites", "canvases", "commands"])("checks %s budget before reading elements", (kind) => {
  const maximum = kind === "commands" ? 99_999 : 100_000;
  const entries = Array(maximum).fill(kind === "commands" ? { type: "clear" } : {});
  const resources =
    kind === "commands" ? { canvases: [{ commands: entries }] } : { [kind]: entries };
  const presentation = { resources, lines: [], htmlIsland: [], scene: { layers: [] } };
  expect(performancePresentationInventory(presentation).truncated).toBe(false);
  Object.defineProperty(entries, maximum, {
    get() {
      throw new Error("over budget element read");
    },
  });
  expect(performancePresentationInventory(presentation).truncated).toBe(true);
});

it("shares one budget across sprites and canvases", () => {
  const canvases: unknown[] = [];
  Object.defineProperty(canvases, 0, {
    get() {
      throw new Error("canvas beyond shared budget");
    },
  });
  expect(
    performancePresentationInventory({
      resources: { sprites: Array(100_000).fill({}), canvases },
      lines: [],
      htmlIsland: [],
      scene: { layers: [] },
    }).truncated,
  ).toBe(true);
});
