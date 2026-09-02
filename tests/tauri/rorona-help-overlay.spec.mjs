import assert from "node:assert/strict";

import { snapshot, waitForProject } from "./rorona-flow.mjs";
import { waitForRuntimeProgress } from "./runtime-progress.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_RORONA_HELP_OVERLAY ? describe : describe.skip;

enabled("Tauri erarorona help overlay", () => {
  it("closes an AnyKey help overlay when its button text is clicked", async () => {
    await waitForProject();
    const before = await snapshot();
    assert.equal(before.wait?.kind, "any_key");
    assert.equal(before.fault, null);

    const target = await lastVisibleButton();
    assert.ok(target, "the help overlay had no visible text button");
    await $(`.game-line[data-index="${target.lineIndex}"] button`).click();

    const after = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "clicking the help text did not dismiss its AnyKey wait",
      totalTimeout: 30_000,
      accept: (state) =>
        state?.fault == null &&
        state?.canInteract &&
        (state.wait?.wait_id !== before.wait.wait_id || state.wait?.kind !== "any_key"),
    });
    assert.notEqual(after.wait?.wait_id, before.wait.wait_id);
    assert.equal(after.fault, null);
  });
});

async function lastVisibleButton() {
  return browser.execute(() => {
    const viewport = document.querySelector(".game-viewport");
    if (!(viewport instanceof HTMLElement)) return null;
    const viewportBounds = viewport.getBoundingClientRect();
    const candidates = [...viewport.querySelectorAll(".game-line button")]
      .filter((button) => {
        const bounds = button.getBoundingClientRect();
        return (
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.bottom > viewportBounds.top &&
          bounds.top < viewportBounds.bottom
        );
      })
      .map((button) => ({
        lineIndex: Number(button.closest(".game-line")?.getAttribute("data-index")),
        text: button.textContent?.trim() ?? "",
      }))
      .filter((button) => Number.isFinite(button.lineIndex) && button.text.length > 0);
    return candidates.at(-1) ?? null;
  });
}
