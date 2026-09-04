/* global document, window */

import { cancelProjectExportDuringTransfer } from "./project-export-cancel.mjs";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  assertProjectStorage,
  typedValues,
  validateExpectedValues,
} from "./interop-assertions.mjs";
import {
  assertLayout,
  assertStringPrefixes,
  assertSubset,
  queryCanvasPixels,
  queryLayout,
  queryLocator,
  resolveLocator,
  sampleQueries,
} from "./web-test-query.mjs";

export * from "./web-test-browser.mjs";
export * from "./web-test-project.mjs";
export { resolveLocator } from "./web-test-query.mjs";
export {
  goalStatus,
  observationFromSnapshot,
  runtimeProgressDiagnostic,
  runtimeProgressSignature,
  snakeAudioRelations,
  snakeAudioStressRelations,
  terminalRuntimeRejection,
} from "./web-test-runtime.mjs";
export {
  compareObservations,
  REFERENCE_SCHEMA_VERSION,
  ReferenceProcess,
} from "./web-test-reference.mjs";

export function assertAtomicPresentationTransition(samples, completedRevision) {
  if (!Array.isArray(samples) || samples.length < 2)
    throw new Error("atomic presentation probe did not capture a painted transition");
  const startRevision = String(samples[0].revision);
  const endRevision = String(completedRevision);
  if (startRevision === endRevision)
    throw new Error(`atomic presentation transition did not advance from ${startRevision}`);
  const intermediate = samples.filter((sample) => {
    const revision = String(sample.revision);
    return revision !== startRevision && revision !== endRevision;
  });
  if (intermediate.length > 0) {
    throw new Error(
      `presentation transition painted intermediate revisions: ${JSON.stringify({ startRevision, endRevision, intermediate })}`,
    );
  }
  if (!samples.some((sample) => String(sample.revision) === endRevision)) {
    throw new Error(`atomic presentation probe did not paint completed revision ${endRevision}`);
  }
  return {
    startRevision,
    endRevision,
    paintedRevisions: [...new Set(samples.map((sample) => String(sample.revision)))],
    samples,
  };
}

async function startAtomicPresentationProbe(page) {
  await page.evaluate(() => {
    window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__?.stop?.();
    const samples = [];
    let frame;
    let stopped = false;
    const capture = () => {
      const snapshot = window.__RUSTYERA_TEST__.snapshot();
      const sample = {
        revision: String(snapshot.presentationRevision),
        waitId: snapshot.wait?.wait_id == null ? null : String(snapshot.wait.wait_id),
        canInteract: snapshot.canInteract,
        outputCount: snapshot.output.length,
        outputTail: snapshot.output.slice(-6),
      };
      const previous = samples.at(-1);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(sample)) samples.push(sample);
    };
    const sampleFrame = () => {
      if (stopped) return;
      capture();
      frame = window.requestAnimationFrame(sampleFrame);
    };
    capture();
    frame = window.requestAnimationFrame(sampleFrame);
    window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__ = {
      stop() {
        if (!stopped) {
          stopped = true;
          if (frame != null) window.cancelAnimationFrame(frame);
          capture();
        }
        delete window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__;
        return samples;
      },
    };
  });
}

async function stopAtomicPresentationProbe(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  return page.evaluate(() => window.__RUSTYERA_ATOMIC_PRESENTATION_PROBE__?.stop?.() ?? []);
}

export async function runAction(page, action) {
  if (action.type === "cancel_project_export")
    return cancelProjectExportDuringTransfer(page, action);
  if (action.type === "save_download") {
    assert.ok(typeof action.path === "string" && path.isAbsolute(action.path));
    assert.ok(typeof action.name_suffix === "string" && action.name_suffix.length > 0);
    assert.ok(typeof action.selector === "string" && action.selector.length > 0);
    await lstat(action.path).then(
      () => {
        throw new Error("download destination already exists");
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    // Full-project exports stream through a real Blob download, not the small test download
    // queue. Arm the native framework event before clicking so fast exports cannot be missed.
    // The scenario deadline and complete-state watchdog close the browser on failure;
    // a separate default 30-second event timeout must not cut off an advancing export.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 0 }),
      page.locator(action.selector).click(),
    ]);
    const name = download.suggestedFilename();
    assert.ok(name.endsWith(action.name_suffix), "unexpected downloaded artifact");
    assert.equal(await download.failure(), null, "native download failed");
    const source = await download.path();
    assert.ok(source, "native download path missing");
    const bytes = (await stat(source)).size;
    assert.ok(bytes > 0, "native download is empty");
    await mkdir(path.dirname(action.path), { recursive: true });
    await copyFile(source, action.path, fsConstants.COPYFILE_EXCL);
    return {
      query: { download: { name, path: action.path, bytes } },
    };
  }
  if (action.type === "assert_interop") {
    const expected = validateExpectedValues(action.expect);
    assert.ok(
      typeof action.evidence_path === "string" && path.isAbsolute(action.evidence_path),
      "assert_interop requires an absolute evidence_path",
    );
    const watches = Object.keys(expected);
    const typed = await page.evaluate(
      (names) => window.__RUSTYERA_TEST__.inspectTyped(names),
      watches,
    );
    const state = await page.evaluate(() => {
      const state = window.__RUSTYERA_TEST__.snapshotSummary();
      return {
        bridgeKind: state.bridgeKind,
        buildIdentity: state.buildIdentity,
        fault: state.fault,
        storage: window.__RUSTYERA_TEST__.protocolEvidence(["storage_request", "storage_response"]),
      };
    });
    const observation = {
      ...state,
      typed,
      restorePath: "see scenario actions and correlated storage records",
    };
    // Retain raw protocol values even when comparison or storage validation fails.
    await mkdir(path.dirname(action.evidence_path), { recursive: true });
    await writeFile(action.evidence_path, JSON.stringify(observation, null, 2) + "\n", {
      flag: "wx",
    });
    assert.equal(state.bridgeKind, "browser");
    assert.equal(state.fault, null);
    assert.deepEqual(typedValues(typed, watches), expected);
    assertProjectStorage(state.storage);
    return { query: { interop: observation } };
  }
  if (action.type === "edit_project_source") {
    await page.evaluate(
      (request) =>
        window.__RUSTYERA_TEST__.replaceProjectSource(
          request.relative_path,
          request.expected,
          request.replacement,
        ),
      action,
    );
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "reload_project") {
    const previousEpoch = await page.evaluate(
      () => window.__RUSTYERA_TEST__.snapshot().runtimeEpoch,
    );
    const expectSuccess = action.expect_success !== false;
    await page.evaluate(
      ({ scope, path }) => window.__RUSTYERA_TEST__.reloadProject(scope, path),
      action,
    );
    await page.waitForFunction(
      ({ epoch, expectSuccess }) => {
        const state = window.__RUSTYERA_TEST__.snapshot();
        if (state.projectLoading !== false || state.canInteract !== true) return false;
        return expectSuccess
          ? Number(state.runtimeEpoch) > Number(epoch)
          : Number(state.runtimeEpoch) === Number(epoch) && state.status.includes("失败");
      },
      { epoch: previousEpoch, expectSuccess },
    );
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "export_diagnosis") {
    const previousDownloads = await page.evaluate(
      () => window.__RUSTYERA_TEST_DOWNLOADS__?.length ?? 0,
    );
    await page.evaluate(() => window.__RUSTYERA_TEST__.exportDiagnosis());
    await page.waitForFunction((downloads) => {
      const state = window.__RUSTYERA_TEST__.snapshot();
      return (
        state.diagnosis?.exporting === false &&
        (window.__RUSTYERA_TEST_DOWNLOADS__?.length ?? 0) > downloads
      );
    }, previousDownloads);
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "wait_compiled_cache_saved") {
    await page.waitForFunction(
      () => {
        const state = window.__RUSTYERA_TEST__.snapshot();
        return (
          state.status === "项目缓存已保存。" ||
          state.logs?.some((entry) =>
            String(entry.message).includes("runtime.compiled_cache_failed"),
          )
        );
      },
      undefined,
      { timeout: 0 },
    );
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    const failure = state.logs?.find((entry) =>
      String(entry.message).includes("runtime.compiled_cache_failed"),
    );
    if (failure) throw new Error(`compiled cache export failed: ${String(failure.message)}`);
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "assert_diagnosis_project_manifest") {
    const state = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    const actual = state.lastDownload?.projectHashes ?? {};
    for (const [relativePath, source] of Object.entries(action.sources ?? {})) {
      const expected = hex(blake3(new TextEncoder().encode(String(source))));
      if (actual[relativePath] !== expected) {
        throw new Error(
          `diagnosis project source mismatch for ${relativePath}: expected ${expected}, got ${actual[relativePath]}`,
        );
      }
    }
    return { semanticInput: action.semantic_input };
  }
  if (action.type === "advance_intermediate_waits_until") {
    const maximum = Number(action.maximum ?? 100);
    const mediaSourcesAtLeast = Number(action.until?.media_sources_at_least ?? 0);
    if (!Number.isInteger(mediaSourcesAtLeast) || mediaSourcesAtLeast <= 0)
      throw new Error(
        "advance_intermediate_waits_until requires a positive until.media_sources_at_least",
      );
    let numericInputs = 0;
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const sourceCount = await page.evaluate(() => {
        const media = window.__RUSTYERA_TEST__.mediaPlacements();
        return new Set(
          (media.images ?? []).map((item) => item?.source).filter((source) => Boolean(source)),
        ).size;
      });
      if (sourceCount >= mediaSourcesAtLeast)
        return { semanticInput: "", attempts: attempt, numericInputs, mediaSources: sourceCount };
      if (attempt === maximum)
        throw new Error(
          `intermediate wait budget exhausted before ${mediaSourcesAtLeast} media sources appeared`,
        );

      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
      if (!snapshot.wait) {
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
        continue;
      }
      if (snapshot.wait.deadline_ns != null) {
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      const waitId = snapshot.wait.wait_id;
      if (snapshot.wait.kind === "integer_value") {
        const input = page.locator(".prompt-bar input");
        await input.fill(String(action.integer_value ?? 0));
        await page.locator(".prompt-bar button[type=submit]").click();
        numericInputs += 1;
      } else if (
        ["enter_key", "any_key", "void"].includes(snapshot.wait.kind) ||
        (snapshot.wait.one_input && snapshot.wait.kind === "string_value")
      ) {
        if (snapshot.wait.kind === "string_value")
          await page.locator(".game-viewport .game-button").first().click();
        else await page.locator(".prompt-bar button[type=submit]").click();
      } else {
        throw new Error(
          `advance_intermediate_waits_until reached unexpected ${snapshot.wait.kind} prompt`,
        );
      }
      await page.waitForFunction((previousWaitId) => {
        const current = window.__RUSTYERA_TEST__.snapshot();
        return current.fault != null || current.wait?.wait_id !== previousWaitId;
      }, waitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "advance_enter_waits_until") {
    const maximum = Number(action.maximum ?? 100);
    const tailLines = Math.max(1, Number(action.until?.tail_lines ?? 30));
    const expectedText = String(action.until?.output_tail_contains ?? "");
    const expectedLocator = action.until?.locator
      ? resolveLocator(page, action.until.locator)
      : undefined;
    if (!expectedText && !expectedLocator)
      throw new Error(
        "advance_enter_waits_until requires until.output_tail_contains or until.locator",
      );
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshotSummary());
      const textReached =
        !expectedText || snapshot.output.slice(-tailLines).join("\n").includes(expectedText);
      const locatorReached =
        !expectedLocator ||
        ((await expectedLocator.count()) > 0 && (await expectedLocator.first().isVisible()));
      if (textReached && locatorReached) return { semanticInput: "", attempts: attempt };
      if (attempt === maximum)
        throw new Error(
          `Enter wait budget exhausted before target screen ${JSON.stringify(action.until)}`,
        );
      if (!snapshot.wait) {
        await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
        continue;
      }
      if (snapshot.wait?.deadline_ns != null) {
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      if (
        !["enter_key", "any_key", "void"].includes(snapshot.wait?.kind) &&
        !(snapshot.wait?.one_input && snapshot.wait?.kind === "string_value")
      )
        throw new Error(
          `advance_enter_waits_until reached unexpected ${snapshot.wait?.kind ?? "missing"} prompt`,
        );
      const waitId = snapshot.wait.wait_id;
      if (action.auto_enter === false) {
        await waitForAutomaticWaitChange(page, waitId);
        continue;
      }
      if (snapshot.wait.kind === "string_value")
        await page.locator(".game-viewport .game-button").first().click();
      else await page.locator(".prompt-bar button[type=submit]").click();
      await page.waitForFunction((previousWaitId) => {
        const current = window.__RUSTYERA_TEST__.snapshotSummary();
        return current.fault != null || current.wait?.wait_id !== previousWaitId;
      }, waitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "drain_void_waits") {
    const maximum = Number(action.maximum ?? 100);
    let automaticTimedWaits = 0;
    for (let attempt = 0; attempt < maximum; attempt += 1) {
      const snapshot = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
      if (snapshot.wait?.kind !== "void")
        return { semanticInput: "", attempts: attempt, automaticTimedWaits };
      if (snapshot.wait.deadline_ns != null) {
        automaticTimedWaits += 1;
        await waitForAutomaticWaitChange(page, snapshot.wait.wait_id);
        continue;
      }
      await page.locator(".prompt-bar button[type=submit]").click();
      await page.waitForTimeout(20);
    }
    throw new Error(`void wait budget exhausted after ${maximum} attempts`);
  }
  if (action.type === "wait_timed_input_change") {
    const before = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    if (before.wait?.deadline_ns == null)
      throw new Error("wait_timed_input_change requires an active timed input wait");
    await waitForAutomaticWaitChange(page, before.wait.wait_id);
    const after = await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot());
    return {
      query: {
        timed_input: {
          previous_wait_id: before.wait.wait_id,
          next_wait_id: after.wait?.wait_id ?? null,
          previous_kind: before.wait.kind,
          next_kind: after.wait?.kind ?? null,
          viewport_policy: before.wait.viewport_policy,
        },
      },
    };
  }
  if (action.type === "input") {
    const beforeWaitId = await page.evaluate(
      () => window.__RUSTYERA_TEST__.snapshotSummary().wait?.wait_id,
    );
    const input = page.locator(".prompt-bar input");
    const value = String(action.value ?? "");
    await input.fill("");
    if (value) await input.pressSequentially(value);
    if (action.keyboard_submit === true) await input.press("Enter");
    else await page.locator(".prompt-bar button[type=submit]").click();
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
    if (action.message_skip) {
      await page.waitForFunction(() => {
        const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
        return snapshot.canInteract && snapshot.wait?.kind === "enter_key";
      });
      await page.locator(".game-viewport").click({ button: "right" });
    }
    return { semanticInput: value };
  }
  if (action.type === "click_until_text") {
    const maximum = Math.max(0, Number(action.maximum ?? 10));
    const required = (action.until_text ?? []).map(String);
    const forbidden = (action.until_not_text ?? []).map(String);
    for (let attempt = 0; attempt <= maximum; attempt += 1) {
      const target = resolveLocator(page, action.locator);
      const value = (await target.textContent()) ?? "";
      if (
        required.every((text) => value.includes(text)) &&
        forbidden.every((text) => !value.includes(text))
      )
        return { semanticInput: action.semantic_input, attempts: attempt, text: value };
      if (attempt === maximum)
        throw new Error(`click_until_text did not reach ${JSON.stringify(action)}`);
      const beforeWaitId = await page.evaluate(
        () => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id,
      );
      await target.click();
      if (beforeWaitId != null)
        await page.waitForFunction((waitId) => {
          const snapshot = window.__RUSTYERA_TEST__.snapshot();
          return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
        }, beforeWaitId);
      await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
    }
  }
  if (action.type === "sample_queries") return sampleQueries(page, action);
  if (action.type === "set_viewport") {
    const width = Number(action.width);
    const height = Number(action.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
      throw new Error("set_viewport requires positive integer width and height");
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    );
    return { query: { viewport: { width, height } } };
  }
  if (action.type === "set_game_text_style") {
    const family = String(action.font_family ?? "").trim();
    const size = Number(action.font_size);
    if (!family || !Number.isFinite(size) || size <= 0)
      throw new Error("set_game_text_style requires a font family and positive font size");
    await page.evaluate(
      ({ family, size }) => {
        const application = document.querySelector(".app-shell");
        if (!(application instanceof globalThis.HTMLElement))
          throw new Error("app shell is not available");
        let sheet = document.querySelector("#rustyera-test-game-text-style");
        if (!(sheet instanceof globalThis.HTMLStyleElement)) {
          sheet = document.createElement("style");
          sheet.id = "rustyera-test-game-text-style";
          document.head.append(sheet);
        }
        sheet.textContent = "[data-rustyera-test-game-text-style] {}";
        const rule = sheet.sheet?.cssRules[0];
        if (!(rule instanceof globalThis.CSSStyleRule))
          throw new Error("test style rule is not available");
        rule.style.setProperty("--game-font", family, "important");
        rule.style.setProperty("--game-size", `${size}px`, "important");
        rule.style.setProperty("--game-line-height", `${size + 1}px`, "important");
        application.dataset.rustyeraTestGameTextStyle = "";
      },
      { family, size },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    );
    return { query: { game_text_style: { font_family: family, font_size: `${size}px` } } };
  }
  if (action.type === "reveal_text") {
    const expected = String(action.text ?? "");
    if (!expected) throw new Error("reveal_text requires text");
    const revealed = await page.evaluate(async (text) => {
      const viewport = document.querySelector(".game-viewport");
      if (!(viewport instanceof globalThis.HTMLElement)) return false;
      const settle = () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        );
      const step = Math.max(1, Math.floor(viewport.clientHeight / 2));
      viewport.scrollTop = 0;
      for (let position = 0; position <= viewport.scrollHeight + step; position += step) {
        await settle();
        const target = [...document.querySelectorAll(".game-line")].find((line) =>
          line.textContent?.includes(text),
        );
        if (target instanceof globalThis.HTMLElement) {
          target.scrollIntoView({ block: "center" });
          await settle();
          return true;
        }
        viewport.scrollTop = position + step;
      }
      return false;
    }, expected);
    if (!revealed) throw new Error(`reveal_text could not find ${JSON.stringify(expected)}`);
    return { query: { revealed_text: expected } };
  }
  const locator = action.locator ? resolveLocator(page, action.locator) : undefined;
  if (action.type === "touch_gesture") {
    const gesture = String(action.gesture ?? "");
    if (!["two_finger_tap", "long_press"].includes(gesture))
      throw new Error("touch_gesture requires two_finger_tap or long_press");
    const box = await locator.boundingBox();
    if (!box) throw new Error("touch_gesture target is not visible");
    const beforeWaitId = action.advances_game
      ? await page.evaluate(() => window.__RUSTYERA_TEST__.snapshot().wait?.wait_id)
      : undefined;
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    const session = await page.context().newCDPSession(page);
    let failure;
    let touchStarted = false;
    try {
      const touchPoints =
        gesture === "two_finger_tap"
          ? [
              { x: centerX - 18, y: centerY, id: 1, radiusX: 8, radiusY: 8, force: 1 },
              { x: centerX + 18, y: centerY, id: 2, radiusX: 8, radiusY: 8, force: 1 },
            ]
          : [{ x: centerX, y: centerY, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
      touchStarted = true;
      await page.waitForTimeout(gesture === "long_press" ? 650 : 80);
    } catch (error) {
      failure = error;
    }
    if (touchStarted) {
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await session.detach();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    if (beforeWaitId != null)
      await page.waitForFunction((waitId) => {
        const snapshot = window.__RUSTYERA_TEST__.snapshot();
        return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
      }, beforeWaitId);
  } else if (action.type === "click") {
    const runtimeInput = await locator.evaluate((element) =>
      Boolean(
        (element.closest(".game-viewport") &&
          (element.matches("button") || element.closest("button"))) ||
        element.matches(".interaction-assist-action") ||
        element.closest(".interaction-assist-action"),
      ),
    );
    const beforeWaitId = runtimeInput
      ? await page.evaluate(() => window.__RUSTYERA_TEST__.snapshotSummary().wait?.wait_id)
      : undefined;
    let transitionSamples;
    let completedRevision;
    if (action.expect_atomic_presentation === true) {
      if (!runtimeInput)
        throw new Error("expect_atomic_presentation requires a runtime input button");
      await startAtomicPresentationProbe(page);
    }
    try {
      if (action.dom_click === true) await locator.evaluate((element) => element.click());
      else await locator.click({ button: action.button ?? "left", force: action.force === true });
      if (beforeWaitId != null)
        await page.waitForFunction((waitId) => {
          const snapshot = window.__RUSTYERA_TEST__.snapshotSummary();
          return snapshot.fault != null || snapshot.wait?.wait_id !== waitId;
        }, beforeWaitId);
      if (action.expect_atomic_presentation === true)
        completedRevision = await page.evaluate(async () => {
          await window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true);
          return String(window.__RUSTYERA_TEST__.snapshot().presentationRevision);
        });
    } finally {
      if (action.expect_atomic_presentation === true)
        transitionSamples = await stopAtomicPresentationProbe(page);
    }
    if (action.settle_ms != null) await page.waitForTimeout(Number(action.settle_ms));
    if (transitionSamples)
      return {
        query: {
          presentation_transition: assertAtomicPresentationTransition(
            transitionSamples,
            completedRevision,
          ),
        },
        semanticInput: action.semantic_input,
      };
  } else if (action.type === "scroll_key") {
    await locator.focus();
    await page.keyboard.press(String(action.key ?? "PageUp"));
    await page.waitForTimeout(Number(action.settle_ms ?? 50));
  } else if (action.type === "dblclick") await locator.dblclick();
  else if (action.type === "hover") await locator.hover();
  else if (action.type === "fill") await locator.fill(String(action.value ?? ""));
  else if (action.type === "press") await locator.press(String(action.key));
  else if (["query", "assert_dom"].includes(action.type)) {
    const actual = await queryLocator(locator, action.fields);
    if (action.type === "assert_dom") assertSubset(actual, action.expect ?? {});
    return { query: actual, semanticInput: action.semantic_input };
  } else if (action.type === "assert_layout") {
    const relative = action.relative_to ? resolveLocator(page, action.relative_to) : undefined;
    const actual = await queryLayout(locator, relative, action.box, action.relative_box);
    assertLayout(actual, action.expect ?? {});
    return { query: { layout: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "assert_canvas_pixels") {
    const actual = await queryCanvasPixels(locator);
    const expected = { ...(action.expect ?? {}) };
    if (expected.nontransparent_at_least != null) {
      const minimum = Number(expected.nontransparent_at_least);
      if (actual.nontransparent < minimum)
        throw new Error(
          `assertion failed at canvas_pixels.nontransparent: expected at least ${minimum}, got ${actual.nontransparent}`,
        );
      delete expected.nontransparent_at_least;
    }
    assertSubset(actual, expected);
    return { query: { canvas_pixels: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "query_media_replay") {
    const actual = await page.evaluate(
      (resourceName) => window.__RUSTYERA_TEST__.mediaReplay(resourceName),
      String(action.resource_name),
    );
    if (action.expect) assertSubset(actual, action.expect);
    return { query: { media_replay: actual }, semanticInput: action.semantic_input };
  } else if (action.type === "assert_state") {
    // Ordinary state checks must not clone the entire startup wire ledger. Explicit
    // evidence assertions still receive the full records and lifecycle observations.
    const needsEvidence = [action.expect, action.expect_prefix].some(
      (expected) =>
        expected != null &&
        (Object.hasOwn(expected, "serviceEvidence") || Object.hasOwn(expected, "serviceLifecycle")),
    );
    const state = await page.evaluate(
      (fullEvidence) =>
        fullEvidence
          ? window.__RUSTYERA_TEST__.snapshot()
          : window.__RUSTYERA_TEST__.snapshotSummary(),
      needsEvidence,
    );
    assertSubset(state, action.expect ?? {});
    assertStringPrefixes(state, action.expect_prefix ?? {});
    return { state };
  } else throw new Error(`unknown action type ${action.type}`);
  return { semanticInput: action.semantic_input };
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function waitForAutomaticWaitChange(page, waitId) {
  await page.waitForFunction((previousWaitId) => {
    const current = window.__RUSTYERA_TEST__.snapshotSummary();
    return current.fault != null || current.wait?.wait_id !== previousWaitId;
  }, waitId);
  await page.evaluate(() => window.__RUSTYERA_TEST__.waitForStableObservation(30_000, true));
}

export async function waitForRuntimeObservation(page, timeout, summary = false) {
  return page.evaluate(
    async ({ timeoutMs, summary }) => {
      let observing = true;
      const timedInput = new Promise((resolve) => {
        const poll = () => {
          if (!observing) return;
          const current = window.__RUSTYERA_TEST__.snapshotSummary();
          if (current.canInteract && current.wait?.deadline_ns != null) {
            resolve(summary ? current : window.__RUSTYERA_TEST__.snapshot());
            return;
          }
          window.requestAnimationFrame(poll);
        };
        poll();
      });
      try {
        return await Promise.race([
          summary
            ? window.__RUSTYERA_TEST__.waitForStableObservation(timeoutMs, true)
            : window.__RUSTYERA_TEST__.waitForStableObservation(timeoutMs),
          timedInput,
        ]);
      } finally {
        observing = false;
      }
    },
    { timeoutMs: timeout, summary },
  );
}

export function shellWords(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  return (
    String(value)
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  );
}
