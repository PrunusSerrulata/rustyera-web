import { describe, expect, it } from "vitest";
import { assertXrayLayout } from "../scripts/snake-xray-layout.mjs";

function layout() {
  const image = (x, y, width, height, canvas = false) => ({
    slot: { x, y, width, height: 20 },
    visual: { x, y, width, height, right: x + width, bottom: y + height },
    imageReady: !canvas,
    canvasReady: canvas,
    canvasSize: canvas ? [100, 100] : null,
    opaquePixels: canvas ? 50 : 0,
    clip: { x: 0, y: 0, right: 616, bottom: 500 },
    pixels: {
      actualSize: [100, 100],
      expectedSize: [100, 100],
      mismatchedPixels: 0,
      maxChannelDelta: 0,
    },
  });
  return {
    ready: true,
    center: { x: 0, right: 616 },
    viewport: { x: 0, y: 0, right: 616, bottom: 500 },
    state: { fault: null, canInteract: true },
    images: [
      image(200, 100, 180, 180),
      image(200, 100, 180, 180),
      image(200, 100, 180, 180),
      image(380, 100, 36, 180),
      image(380, 136, 36, 36, true),
      image(380, 244, 36, 36, true),
      image(380, 100, 36, 36),
    ],
  };
}

describe("snapshot Xray geometry verdict", () => {
  it("accepts complete aligned components", () =>
    expect(() => assertXrayLayout(layout())).not.toThrow());
  it("rejects blank generated components even when all nodes exist", () => {
    const value = layout();
    value.images[4].opaquePixels = 0;
    expect(() => assertXrayLayout(value)).toThrow("blank");
  });
  it("rejects a collapsed transparent slot", () => {
    const value = layout();
    value.images[3].slot.width = 0;
    expect(() => assertXrayLayout(value)).toThrow("slot width");
  });
  it("rejects incorrect nonempty generated pixels", () => {
    const value = layout();
    value.images[4].pixels.mismatchedPixels = 123;
    value.images[4].pixels.maxChannelDelta = 255;
    expect(() => assertXrayLayout(value)).toThrow("independent expected PNG");
  });
  it("rejects incorrect static W pixels", () => {
    const value = layout();
    value.images[6].pixels.mismatchedPixels = 1;
    expect(() => assertXrayLayout(value)).toThrow("independent expected PNG");
  });
  it("rejects an internally aligned group shifted eighteen pixels", () => {
    const value = layout();
    for (const image of value.images) {
      image.visual.x += 18;
      image.visual.right += 18;
    }
    expect(() => assertXrayLayout(value)).toThrow("composition center");
  });
  it("rejects components clipped by an ancestor", () => {
    const value = layout();
    value.images[5].clip.bottom = 270;
    expect(() => assertXrayLayout(value)).toThrow("clipped");
  });
  it("rejects components extending below the viewport", () => {
    const value = layout();
    value.viewport.bottom = 270;
    expect(() => assertXrayLayout(value)).toThrow("clipped");
  });
  it("rejects misplaced components", () => {
    const value = layout();
    value.images[5].visual.y -= 100;
    expect(() => assertXrayLayout(value)).toThrow("component y");
  });
});
