import assert from "node:assert/strict";

const PROJECT_TIMEOUT = 120_000;
const STEP_TIMEOUT = 30_000;
const PORTRAIT_TIMEOUT = 60_000;
const akumaMaidImages = process.env.VITE_RUSTYERA_TAURI_AKUMA_MAID_IMAGES
  ? describe
  : describe.skip;

akumaMaidImages("Tauri eraAkumaMaid image rendering", () => {
  it("renders the positioned title and the generated maid portrait", async () => {
    let stage = "install test control";
    let title;
    try {
      await browser.waitUntil(async () => Boolean(await snapshot()), {
        timeout: 20_000,
        timeoutMsg: "test control was not installed in the Tauri WebView",
      });
      assert.equal((await snapshot()).bridgeKind, "tauri");

      stage = "open eraAkumaMaid";
      await $(".welcome .primary").click();
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          return state?.projectOpen && state.phase === "waiting_input" && state.canInteract;
        },
        {
          timeout: PROJECT_TIMEOUT,
          timeoutMsg: "eraAkumaMaid did not reach its title input",
        },
      );
      await $(".media-positioned .media-sprite img").waitForDisplayed({
        timeout: STEP_TIMEOUT,
      });

      stage = "verify title image";
      title = await titleMetrics();
      assert.equal(title.spacerWidth, 432);
      assert.equal(title.imageHeight, 432);
      assert.equal(title.imageTop, -396);
      assert.ok(title.bottomAligned, "short title history must be bottom-aligned");
      assert.ok(
        title.imageViewportTop >= -0.5,
        "title image must not be clipped above the viewport",
      );
      assert.ok(
        title.imageViewportBottom <= title.viewportHeight + 0.5,
        "title image must not be clipped below the viewport",
      );
      assert.ok(title.dividerGap >= -0.5, "title image must not overlap the following divider");
      assert.ok(title.textGap >= -0.5, "title image must not overlap the following title text");
      await reportProgress(stage);

      const inputs = [0, 0, 0, 100, 100, 100, 100, 0];
      for (const [index, value] of inputs.entries()) {
        stage = `submit initialization input ${index + 1}/${inputs.length}: ${value}`;
        await submit(value, index === inputs.length - 1 ? "enter_key" : "integer_value");
        await reportProgress(stage);
      }

      stage = "advance opening messages";
      for (let attempts = 0; attempts < 48; attempts += 1) {
        const state = await snapshot();
        if (state.output?.some((line) => line.includes("弗理希艾尔"))) break;
        assert.ok(
          ["enter_key", "void"].includes(state.wait?.kind),
          `opening flow reached unexpected ${state.wait?.kind ?? "missing"} prompt`,
        );
        const waitId = state.wait.wait_id;
        await $(".prompt-bar button[type=submit]").click();
        await browser.waitUntil(
          async () => {
            const current = await snapshot();
            return (
              current.wait?.wait_id !== waitId ||
              current.output?.some((line) => line.includes("弗理希艾尔"))
            );
          },
          { timeout: STEP_TIMEOUT, timeoutMsg: "timed opening wait did not advance" },
        );
        await reportProgress(`${stage}: ${state.wait.kind} ${attempts + 1}`);
      }

      stage = "wait for generated maid portrait";
      await browser.waitUntil(
        async () => {
          const state = await snapshot();
          if (!state?.output?.some((line) => line.includes("弗理希艾尔"))) return false;
          const portrait = await portraitMetrics();
          return portrait.count > 0 && portrait.loaded === portrait.count;
        },
        {
          timeout: PORTRAIT_TIMEOUT,
          timeoutMsg: "generated maid portrait did not become visible",
        },
      );

      const state = await snapshot();
      const portrait = await portraitMetrics();
      console.log(
        JSON.stringify({
          project: process.env.VITE_RUSTYERA_TEST_PROJECT,
          bridgeKind: state.bridgeKind,
          phase: state.phase,
          wait: state.wait,
          outputTail: state.output.slice(-12),
          title,
          portrait,
        }),
      );
      assert.equal(state.bridgeKind, "tauri");
      assert.equal(state.fault, null);
      assert.equal(portrait.count, 10);
      assert.equal(portrait.loaded, portrait.count);
      assert.ok(portrait.width > 0 && portrait.height > portrait.slotHeight);
      assert.ok(portrait.positionedLayerCount >= portrait.count - 1);
      assert.ok(portrait.leftSpread < 1, "portrait layers must share one horizontal origin");
      assert.ok(portrait.topSpread < 1, "portrait layers must share one vertical origin");
    } catch (error) {
      const state = await snapshot().catch(() => null);
      const portrait = await portraitMetrics().catch(() => null);
      console.error(
        JSON.stringify({
          failureStage: stage,
          error: error instanceof Error ? error.message : String(error),
          bridgeKind: state?.bridgeKind,
          phase: state?.phase,
          wait: state?.wait,
          fault: state?.fault,
          outputTail: state?.output?.slice(-12),
          title,
          portrait,
        }),
      );
      throw error;
    }
  });
});

async function snapshot() {
  return browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
}

async function submit(value, nextWaitKind) {
  const initial = await snapshot();
  assert.equal(initial.wait?.kind, "integer_value", `input ${value} requires an integer prompt`);
  const before = initial.wait.wait_id;
  const input = await $(".prompt-bar input");
  await input.setValue(String(value));
  await $(".prompt-bar button[type=submit]").click();
  await browser.waitUntil(
    async () => {
      const current = await snapshot();
      return (
        current?.phase === "waiting_input" &&
        current.canInteract &&
        current.wait?.wait_id !== before &&
        current.wait?.kind === nextWaitKind
      );
    },
    {
      timeout: STEP_TIMEOUT,
      timeoutMsg: `input ${value} did not reach the next ${nextWaitKind} prompt`,
    },
  );
}

async function reportProgress(stage) {
  const state = await snapshot();
  console.log(
    JSON.stringify({
      stage,
      phase: state?.phase,
      wait: state?.wait,
      fault: state?.fault,
      outputTail: state?.output?.slice(-4),
    }),
  );
}

async function titleMetrics() {
  return browser.execute(() => {
    const spacer = document.querySelector(".html-shape-space");
    const image = document.querySelector(".media-positioned .media-sprite");
    const viewport = document.querySelector(".game-viewport");
    const history = document.querySelector(".virtual-history");
    const imageBounds = image?.getBoundingClientRect();
    const viewportBounds = viewport?.getBoundingClientRect();
    const imageLineIndex = Number(image?.closest(".game-line")?.getAttribute("data-index"));
    const laterLines = [...document.querySelectorAll(".game-line")].filter(
      (line) => Number(line.getAttribute("data-index")) > imageLineIndex,
    );
    const dividerBounds = laterLines
      .map((line) => line.querySelector(".separator")?.getBoundingClientRect())
      .find(Boolean);
    const textBounds = laterLines
      .filter((line) => !line.querySelector(".separator"))
      .find((line) => line.textContent?.trim())
      ?.getBoundingClientRect();
    return {
      spacerWidth: spacer?.getBoundingClientRect().width ?? 0,
      imageHeight: image?.getBoundingClientRect().height ?? 0,
      imageTop: Number.parseFloat(getComputedStyle(image).top) || 0,
      bottomAligned: history?.classList.contains("history-bottom-aligned") ?? false,
      viewportHeight: viewportBounds?.height ?? 0,
      imageViewportTop:
        imageBounds && viewportBounds
          ? imageBounds.top - viewportBounds.top
          : Number.NEGATIVE_INFINITY,
      imageViewportBottom:
        imageBounds && viewportBounds
          ? imageBounds.bottom - viewportBounds.top
          : Number.POSITIVE_INFINITY,
      dividerGap:
        imageBounds && dividerBounds
          ? dividerBounds.top - imageBounds.bottom
          : Number.NEGATIVE_INFINITY,
      textGap:
        imageBounds && textBounds ? textBounds.top - imageBounds.bottom : Number.NEGATIVE_INFINITY,
    };
  });
}

async function portraitMetrics() {
  return browser.execute(() => {
    const layers = [...document.querySelectorAll(".html-node .media-positioned .media-sprite img")];
    const image = layers[0];
    const visual = image?.parentElement;
    const slot = visual?.parentElement;
    const bounds = layers.map((layer) => layer.parentElement?.getBoundingClientRect());
    const lefts = bounds.flatMap((item) => (item ? [item.left] : []));
    const tops = bounds.flatMap((item) => (item ? [item.top] : []));
    return {
      count: layers.length,
      loaded: layers.filter((layer) => layer.complete && layer.naturalWidth > 0).length,
      width: visual?.getBoundingClientRect().width ?? 0,
      height: visual?.getBoundingClientRect().height ?? 0,
      slotHeight: slot?.getBoundingClientRect().height ?? 0,
      top: visual ? Number.parseFloat(getComputedStyle(visual).top) || 0 : 0,
      positionedLayerCount: layers.filter((layer) => layer.closest(".html-node-positioned")).length,
      leftSpread: lefts.length ? Math.max(...lefts) - Math.min(...lefts) : Number.POSITIVE_INFINITY,
      topSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : Number.POSITIVE_INFINITY,
    };
  });
}
