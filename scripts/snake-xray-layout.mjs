/* global document, window, Image, getComputedStyle */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function loadXrayExpectedImages() {
  const source = process.env.RUSTYERA_XRAY_EXPECTED_IMAGES;
  assert.ok(source, "RUSTYERA_XRAY_EXPECTED_IMAGES is required");
  const expected = JSON.parse(await readFile(source, "utf8"));
  for (const name of ["V", "A", "W"]) {
    const entry = expected[name];
    assert.ok(
      entry?.base64 && /^[a-f0-9]{64}$/i.test(entry.sha256),
      `${name}: missing expected PNG/hash`,
    );
    const bytes = Buffer.from(entry.base64, "base64");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256.toLowerCase(),
      `${name}: expected PNG hash mismatch`,
    );
    assert.equal(
      bytes.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${name}: expected input is not PNG`,
    );
  }
  return expected;
}

// Serializable browser function shared by Playwright and WebDriver. Expected pixels
// come from independently captured game resources, never from the rendered canvas.
export function captureXrayLayout(expected, done) {
  async function capture() {
    const rectangle = (element) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const digest = async (data) =>
      [...new Uint8Array(await window.crypto.subtle.digest("SHA-256", data))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const expectedPixels = {};
    for (const name of ["V", "A", "W"]) {
      const image = new Image();
      image.src = `data:image/png;base64,${expected[name].base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      expectedPixels[name] = {
        width: canvas.width,
        height: canvas.height,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    }
    async function frame() {
      const row = document.querySelector('.game-line[data-line-id="2086"]');
      if (!row) return { ready: false, reason: "snapshot image row is not mounted" };
      const slots = [...row.querySelectorAll(".media-positioned")];
      if (slots.length !== 7)
        return { ready: false, reason: `expected 7 media slots, got ${slots.length}` };
      const viewport = rectangle(document.querySelector(".game-viewport"));
      const images = [];
      for (const [index, slot] of slots.entries()) {
        const visual = slot.querySelector(".media-visual");
        const image = visual?.matches("img") ? visual : visual?.querySelector("img");
        const canvas = visual?.querySelector("canvas.canvas-replay");
        const imageReady = Boolean(image?.complete && image.naturalWidth > 0);
        const canvasReady = Boolean(canvas && canvas.width && canvas.height);
        const clip = { ...viewport };
        for (let ancestor = visual?.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const box = ancestor.getBoundingClientRect();
          const clips = (value) => ["hidden", "clip", "scroll", "auto"].includes(value);
          if (clips(style.overflowX)) {
            clip.x = Math.max(clip.x, box.x + ancestor.clientLeft);
            clip.right = Math.min(clip.right, box.x + ancestor.clientLeft + ancestor.clientWidth);
          }
          if (clips(style.overflowY)) {
            clip.y = Math.max(clip.y, box.y + ancestor.clientTop);
            clip.bottom = Math.min(clip.bottom, box.y + ancestor.clientTop + ancestor.clientHeight);
          }
        }
        const entry = {
          slot: rectangle(slot),
          visual: visual ? rectangle(visual) : null,
          imageReady,
          canvasReady,
          canvasSize: canvas ? [canvas.width, canvas.height] : null,
          opaquePixels: 0,
          clip,
        };
        const name = { 4: "V", 5: "A", 6: "W" }[index];
        if (name && (canvasReady || imageReady)) {
          let target = canvas;
          if (!target) {
            target = document.createElement("canvas");
            target.width = image.naturalWidth;
            target.height = image.naturalHeight;
            target.getContext("2d").drawImage(image, 0, 0);
          }
          const data = target.getContext("2d").getImageData(0, 0, target.width, target.height).data;
          const reference = expectedPixels[name];
          let mismatchedPixels = 0;
          let maxChannelDelta = 0;
          for (let offset = 0; offset < data.length; offset += 4) {
            if (data[offset + 3] > 0) entry.opaquePixels += 1;
            let mismatch = false;
            for (let channel = 0; channel < 4; channel += 1) {
              const difference = Math.abs(
                data[offset + channel] - (reference.data[offset + channel] ?? -255),
              );
              maxChannelDelta = Math.max(maxChannelDelta, difference);
              if (difference > 1) mismatch = true;
            }
            if (mismatch) mismatchedPixels += 1;
          }
          entry.pixels = {
            name,
            actualSize: [target.width, target.height],
            expectedSize: [reference.width, reference.height],
            actualSha256: await digest(data),
            expectedSha256: await digest(reference.data),
            mismatchedPixels,
            maxChannelDelta,
          };
        }
        images.push(entry);
      }
      // Inline wrappers inherit text-align but do not define the alignment area.
      // Use the containing block that actually centers all seven slots.
      let centerElement = row;
      for (
        let ancestor = slots[0].parentElement;
        ancestor && ancestor !== row;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (
          ancestor.contains(slots[6]) &&
          ["block", "flow-root"].includes(style.display) &&
          style.textAlign === "center"
        ) {
          centerElement = ancestor;
          break;
        }
      }
      return {
        ready:
          images.every((image) => image.visual && (image.imageReady || image.canvasReady)) &&
          images.slice(4, 6).every((image) => image.opaquePixels > 0),
        images,
        row: rectangle(row),
        center: rectangle(centerElement),
        viewport,
        state: window.__RUSTYERA_TEST__.snapshotSummary(),
      };
    }
    const before = await frame();
    if (!before.ready) return before;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
    );
    const after = await frame();
    const signature = (value) =>
      JSON.stringify({ images: value.images, center: value.center, viewport: value.viewport });
    if (!after.ready || signature(before) !== signature(after))
      return { ...after, ready: false, reason: "media changed across two animation frames" };
    return after;
  }
  const result = capture();
  if (typeof done === "function") {
    result.then(done, (error) => done({ ready: false, error: String(error?.stack ?? error) }));
    return;
  }
  return result;
}

export function assertXrayLayout(layout) {
  assert.equal(
    layout.ready,
    true,
    layout.error ?? layout.reason ?? "media did not finish rendering",
  );
  assert.equal(layout.state.fault, null);
  assert.equal(layout.state.canInteract, true);
  const [portrait, second, third, slot, upper, lower, top] = layout.images;
  const close = (actual, expected, name) =>
    assert.ok(Math.abs(actual - expected) <= 1, `${name}: ${actual} != ${expected}`);
  const scale = portrait.visual.width / 180;
  assert.ok(Number.isFinite(scale) && scale > 0);
  for (const layer of [second, third]) {
    close(layer.visual.x, portrait.visual.x, "portrait layer x");
    close(layer.visual.y, portrait.visual.y, "portrait layer y");
  }
  close(slot.slot.width, 36 * scale, "transparent slot width");
  close(slot.visual.height, 180 * scale, "transparent slot height");
  close(slot.visual.x, portrait.visual.right, "reserved horizontal position");
  close(slot.visual.right - portrait.visual.x, 216 * scale, "whole composition width");
  close(
    (portrait.visual.x + slot.visual.right) / 2,
    (layout.center.x + layout.center.right) / 2,
    "whole composition center",
  );
  for (const [image, offset] of [
    [upper, 36],
    [lower, 144],
    [top, 0],
  ]) {
    close(image.visual.x, slot.visual.x, "component x");
    close(image.visual.y, slot.visual.y + offset * scale, "component y");
    close(image.visual.width, 36 * scale, "component width");
    close(image.visual.height, 36 * scale, "component height");
    assert.deepEqual(
      image.pixels?.actualSize,
      image.pixels?.expectedSize,
      "component source dimensions",
    );
    assert.ok(
      image.pixels && image.pixels.mismatchedPixels === 0 && image.pixels.maxChannelDelta <= 1,
      `${image.pixels?.name}: component pixels differ from independent expected PNG`,
    );
  }
  for (const image of layout.images) {
    const box = image.visual;
    for (const clip of [layout.viewport, image.clip]) {
      assert.ok(
        clip &&
          box.x >= clip.x - 1 &&
          box.y >= clip.y - 1 &&
          box.right <= clip.right + 1 &&
          box.bottom <= clip.bottom + 1,
        "media component is clipped",
      );
    }
  }
  for (const image of [upper, lower]) {
    assert.equal(image.canvasReady, true, "generated component is not a canvas");
    assert.deepEqual(image.canvasSize, [100, 100]);
    assert.ok(image.opaquePixels > 0, "generated component remains blank");
  }
  assert.equal(top.imageReady, true, "static component did not load");
}

export async function waitForXrayLayout(capture, expected) {
  const deadline = Date.now() + 15000;
  let layout;
  do {
    layout = await capture(expected);
    if (layout.error) throw new Error(layout.error);
    if (layout.ready) return layout;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Xray images did not settle: ${layout?.reason ?? "media is incomplete"}`);
}

export async function runXrayLayoutProbe(browser, evidencePath) {
  assert.ok(evidencePath, "missing Xray evidence destination");
  let layout;
  try {
    const expected = await loadXrayExpectedImages();
    layout = await waitForXrayLayout(
      (images) => browser.executeAsync(captureXrayLayout, images),
      expected,
    );
    assertXrayLayout(layout);
    await browser.saveScreenshot(`${evidencePath}.png`);
  } finally {
    await writeFile(evidencePath, JSON.stringify(layout ?? { ready: false }, null, 2));
  }
}
