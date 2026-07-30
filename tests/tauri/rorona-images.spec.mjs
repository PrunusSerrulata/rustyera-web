import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const roronaImages = process.env.VITE_RUSTYERA_TAURI_RORONA_IMAGES ? describe : describe.skip;

roronaImages("Tauri erarorona image rendering", () => {
  it("keeps the title and workshop image between their surrounding text", async () => {
    // The Tauri driver accepts physical pixels on Retina. Project the approximately
    // 1400×1000 reference window through the active device scale first.
    const deviceScale = await browser.execute(() => window.devicePixelRatio || 1);
    await browser.setWindowSize(1400 * deviceScale, 1050 * deviceScale);
    await waitForProject();
    await drainVoidWaits(300);
    await submit(0);
    await drainVoidWaits(300);
    await submit(0);
    await submit(999);
    await submit(9);

    let title;
    try {
      await browser.waitUntil(
        async () => {
          title = await titleMetrics();
          return title.count === 1 && title.insideViewport && title.metadataGap >= 0;
        },
        { timeout: STEP_TIMEOUT, timeoutMsg: "title image geometry did not stabilize" },
      );
    } catch (error) {
      console.error(JSON.stringify({ failureStage: "title geometry", title }));
      throw error;
    }
    assert.equal(title.count, 1);
    assert.ok(title.insideViewport, "title image must remain fully inside the viewport");
    assert.ok(title.metadataGap >= 0, "title image must not cover its metadata");

    await submit(0);
    await advanceEnterWaitsUntilWorkshop(1100);

    let workshop;
    await browser.waitUntil(
      async () => {
        workshop = await workshopMetrics();
        return workshop.count === 1 && workshop.statusGap >= 0 && workshop.dialogueGap >= 0;
      },
      { timeout: STEP_TIMEOUT, timeoutMsg: "workshop image geometry did not stabilize" },
    );
    const state = await snapshot();
    console.log(JSON.stringify({ title, workshop, wait: state.wait, fault: state.fault }));
    assert.equal(state.fault, null);
    assert.equal(workshop.count, 1);
    assert.ok(workshop.statusGap >= 0, "workshop image must start below the status header");
    assert.ok(workshop.dialogueGap >= 0, "workshop image must end above the dialogue");
  });
});

async function waitForProject() {
  await browser.waitUntil(async () => Boolean(await snapshot()), {
    timeout: 20_000,
    timeoutMsg: "test control was not installed in the Tauri WebView",
  });
  assert.equal((await snapshot()).bridgeKind, "tauri");
  await $(".welcome .primary").click();
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
    },
    { timeout: PROJECT_TIMEOUT, timeoutMsg: "erarorona did not reach its first input" },
  );
}

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value) {
  const before = await snapshot();
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await waitForWaitChange(before.wait?.wait_id);
}

async function drainVoidWaits(maximum) {
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const state = await snapshot();
    if (state.wait?.kind !== "void") return;
    await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
  throw new Error(`void wait budget exhausted after ${maximum} attempts`);
}

async function advanceEnterWaitsUntilWorkshop(maximum) {
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    const state = await snapshot();
    const textReached = state.output.slice(-40).join("\n").includes("亚斯特丽德的工房");
    const imageReached = (await $(".media-visual.media-sprite").isDisplayed()).valueOf();
    if (textReached && imageReached) return;
    assert.ok(
      ["enter_key", "void"].includes(state.wait?.kind),
      `opening flow reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
    );
    await $(".prompt-bar button[type=submit]").click();
    await waitForWaitChange(state.wait.wait_id);
  }
  throw new Error(`workshop was not visible after ${maximum} Enter waits`);
}

async function waitForWaitChange(waitId) {
  if (waitId == null) return;
  await browser.waitUntil(
    async () => {
      const state = await snapshot();
      return (
        state.fault != null ||
        (state.phase === "waiting_input" && state.canInteract && state.wait?.wait_id !== waitId)
      );
    },
    { timeout: STEP_TIMEOUT, timeoutMsg: "game input did not advance" },
  );
}

async function titleMetrics() {
  return browser.execute(() => {
    const image = document.querySelector(".media-visual.media-sprite");
    const viewport = document.querySelector(".game-viewport");
    const metadata = [...document.querySelectorAll(".game-line")].find(
      (line) => line.textContent?.trim() === "era萝乐娜",
    );
    const bounds = image?.getBoundingClientRect();
    const viewportBounds = viewport?.getBoundingClientRect();
    const metadataBounds = metadata?.getBoundingClientRect();
    return {
      count: image ? 1 : 0,
      imageBounds: bounds
        ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
        : null,
      viewportBounds: viewportBounds
        ? {
            left: viewportBounds.left,
            top: viewportBounds.top,
            right: viewportBounds.right,
            bottom: viewportBounds.bottom,
          }
        : null,
      insideViewport: Boolean(
        bounds &&
        viewportBounds &&
        bounds.left >= viewportBounds.left &&
        bounds.top >= viewportBounds.top &&
        bounds.right <= viewportBounds.right &&
        bounds.bottom <= viewportBounds.bottom,
      ),
      metadataGap: bounds && metadataBounds ? metadataBounds.top - bounds.bottom : -Infinity,
    };
  });
}

async function workshopMetrics() {
  return browser.execute(() => {
    const image = document.querySelector(".media-visual.media-sprite");
    const status = [...document.querySelectorAll(".game-line")]
      .filter((line) => line.textContent?.includes("第1年  1月  8日"))
      .at(-1);
    const dialogue = [...document.querySelectorAll(".game-line")].find((line) =>
      line.textContent?.includes("萝乐娜"),
    );
    const bounds = image?.getBoundingClientRect();
    const statusBounds = status?.getBoundingClientRect();
    const dialogueBounds = dialogue?.getBoundingClientRect();
    return {
      count: image ? 1 : 0,
      statusGap: bounds && statusBounds ? bounds.top - statusBounds.bottom : -Infinity,
      dialogueGap: bounds && dialogueBounds ? dialogueBounds.top - bounds.bottom : -Infinity,
    };
  });
}
