/* global document, getComputedStyle, HTMLInputElement, HTMLElement, navigator, window */

import { byteSignature } from "./browser-compat-support.mjs";

export async function runInteractiveCompatibility({
  browser,
  browserName,
  setup,
  opfsReset,
  startupGuidance,
  projectProgress,
  settingsHotApply,
  checkTooltip,
  setStage,
  clickElement,
  clickFileMenuAction,
  inspectAutomaticInteractionAssist,
  enableGlobalInteractionAssist,
  inspectInteractionAssistPanel,
  inspectOpfsProjectCache,
  assertColdStartup,
}) {
  let minimized = false;
  const clickButton = async (label) => {
    setStage(`clicking ${label}`);
    const button = await browser.$(`//button[normalize-space(.)=${JSON.stringify(label)}]`);
    await button.waitForClickable({ timeout: 30_000 });
    await clickElement(browser, button);
  };
  setStage("checking automatic interaction assistance");
  const automaticInteractionAssist = await inspectAutomaticInteractionAssist(browser);
  setStage("enabling interaction assistance");
  await enableGlobalInteractionAssist(browser);
  setStage("checking the interaction assistance panel");
  const interactionAssist = await inspectInteractionAssistPanel(browser);
  console.log(
    JSON.stringify({ browser: browserName, automaticInteractionAssist, interactionAssist }),
  );
  for (const action of [
    { menuLabel: "重新开始", title: "重新开始游戏" },
    { menuLabel: "返回标题", title: "返回标题" },
  ]) {
    const beforeConfirmation = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
    await clickFileMenuAction(browser, action.menuLabel);
    setStage(`checking ${action.title} confirmation`);
    const confirmation = await browser.$(`section[aria-label='${action.title}']`);
    await confirmation.waitForDisplayed({ timeout: 30_000 });
    if (!(await confirmation.getText()).includes("可能会丢失尚未保存的游戏进度")) {
      throw new Error(`${action.title} confirmation did not warn about progress loss`);
    }
    const cancelled = await browser.execute((title) => {
      const dialog = document.querySelector(`section[aria-label='${title}']`);
      const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === "取消",
      );
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    }, action.title);
    if (!cancelled) throw new Error(`${action.title} confirmation has no cancel button`);
    await confirmation.waitForDisplayed({ reverse: true, timeout: 30_000 });
    const afterCancellation = await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot());
    if (
      afterCancellation.runtimeEpoch !== beforeConfirmation.runtimeEpoch ||
      afterCancellation.presentationRevision !== beforeConfirmation.presentationRevision ||
      JSON.stringify(afterCancellation.output) !== JSON.stringify(beforeConfirmation.output)
    ) {
      throw new Error(`${action.title} cancellation changed the running game`);
    }
  }
  await clickFileMenuAction(browser, "项目设置…");
  setStage("checking font settings");
  const settingsDialog = await browser.$("section[aria-label='RustyEra Web · 项目设置']");
  await settingsDialog.waitForDisplayed({ timeout: 30_000 });
  await clickButton("显示");
  const gameFont = await settingsDialog.$("#setting-FontName");
  await gameFont.setValue("Manually Entered Font");
  const fontAccess = await browser.execute(() => {
    const input = document.querySelector("#setting-FontName");
    const status = document.querySelector(".font-access-status");
    return {
      inputTag: input?.tagName.toLowerCase(),
      inputType: input?.getAttribute("type"),
      list: input?.getAttribute("list"),
      value: input instanceof HTMLInputElement ? input.value : null,
      status: status?.getAttribute("data-state"),
      statusText: status?.textContent?.trim(),
      options: [...document.querySelectorAll("#available-game-fonts option")].map((option) =>
        option.getAttribute("value"),
      ),
    };
  });
  if (
    fontAccess.inputTag !== "input" ||
    fontAccess.inputType !== "text" ||
    fontAccess.list !== "available-game-fonts" ||
    fontAccess.value !== "Manually Entered Font" ||
    fontAccess.status !== "unsupported" ||
    fontAccess.options.length !== 0
  ) {
    throw new Error(`font picker fallback mismatch: ${JSON.stringify(fontAccess)}`);
  }
  if (settingsHotApply) {
    setStage("waiting for the OPFS project cache before applying settings");
    await browser.waitUntil(async () => (await inspectOpfsProjectCache(browser)).exists, {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: "OPFS compiled-project.reracache was not generated",
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return state?.transfer?.export == null && state.status === "游戏运行中";
        }),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "compiled-cache feedback did not restore the stable status",
      },
    );
    const cacheBeforeSettings = await inspectOpfsProjectCache(browser);
    setStage("hot-applying browser font settings");
    await gameFont.setValue("monospace");
    await settingsDialog.$("#setting-FontSize").setValue("19");
    await clickButton("应用");
    await browser.waitUntil(
      () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().status === "项目设置已应用"),
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "settings completion feedback was not displayed",
      },
    );
    await browser.waitUntil(
      () => browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().status === "游戏运行中"),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "settings completion feedback did not restore the stable status",
      },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const viewport = document.querySelector(".game-viewport");
          if (!(viewport instanceof HTMLElement)) return null;
          const style = getComputedStyle(viewport);
          return style.fontFamily === "monospace" && style.fontSize === "19px";
        }),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "browser did not hot-apply the saved game font",
      },
    );
    setStage("checking the refreshed OPFS project cache");
    await browser.waitUntil(
      async () => {
        const cache = await inspectOpfsProjectCache(browser, cacheBeforeSettings.size);
        const appendedBytes = cache.size - cacheBeforeSettings.size;
        return (
          cache.exists &&
          ((cache.hasConfigurationJournal &&
            cache.prefixDigest === cacheBeforeSettings.prefixDigest &&
            appendedBytes > 0 &&
            appendedBytes < 4_096) ||
            cache.prefixDigest !== cacheBeforeSettings.prefixDigest ||
            cache.size !== cacheBeforeSettings.size)
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "browser did not append the reraconfig transaction to its OPFS cache",
      },
    );
    const cacheAfterSettings = await inspectOpfsProjectCache(browser, cacheBeforeSettings.size);
    const appendedBytes = cacheAfterSettings.size - cacheBeforeSettings.size;
    const cacheUpdate =
      cacheAfterSettings.hasConfigurationJournal &&
      cacheAfterSettings.prefixDigest === cacheBeforeSettings.prefixDigest &&
      appendedBytes > 0 &&
      appendedBytes < 4_096
        ? "journal"
        : "rebuilt";
    console.log(
      JSON.stringify({
        browser: browserName,
        settingsHotApply: true,
        fontFamily: "monospace",
        fontSize: "19px",
        cacheUpdate,
        opfsProjectCacheBytes: cacheAfterSettings.size,
        opfsProjectCacheAppendBytes: appendedBytes,
      }),
    );
  }
  await clickButton("取消");
  const safariSaveWaitId =
    browserName === "safari"
      ? await browser.execute(() => window.__RUSTYERA_TEST__?.snapshot().wait?.wait_id ?? null)
      : null;
  await clickButton("[ 0] ----");
  setStage("waiting for in-game save");
  await browser.waitUntil(
    () =>
      browser.execute(
        (activeBrowser, previousWaitId) => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return (
            state?.phase === "waiting_input" &&
            state.canInteract &&
            (activeBrowser !== "safari" || state.wait?.wait_id !== previousWaitId) &&
            !state.logs.some((entry) =>
              String(entry.message).includes("text save lacks unique code"),
            )
          );
        },
        browserName,
        safariSaveWaitId,
      ),
    { timeout: 30_000, interval: 100, timeoutMsg: "in-game save did not complete" },
  );
  await clickFileMenuAction(browser, "导出操作序列…");
  setStage("receiving exported operation sequence");
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(
          window.__RUSTYERA_TEST_DOWNLOADS__?.some((download) =>
            /^input-replay_\d{8}-\d{6}\.jsonl$/.test(download.name),
          ),
        ),
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "operation sequence download was not produced",
    },
  );
  const operationSequence = await browser.execute(() => {
    const index = window.__RUSTYERA_TEST_DOWNLOADS__?.findIndex((download) =>
      /^input-replay_\d{8}-\d{6}\.jsonl$/.test(download.name),
    );
    if (index == null || index < 0) return { ok: false, error: "download disappeared" };
    const [download] = window.__RUSTYERA_TEST_DOWNLOADS__.splice(index, 1);
    try {
      const records = new TextDecoder()
        .decode(download.bytes)
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      return { ok: true, name: download.name, records };
    } catch (error) {
      return {
        ok: false,
        error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
      };
    }
  });
  if (
    !operationSequence.ok ||
    !/^input-replay_\d{8}-\d{6}\.jsonl$/.test(operationSequence.name) ||
    operationSequence.records?.[0]?.record !== "header" ||
    operationSequence.records?.[0]?.fidelity !== "manual_path"
  ) {
    throw new Error(`operation sequence export is malformed: ${JSON.stringify(operationSequence)}`);
  }
  await clickFileMenuAction(browser, "导出存档…");
  await (await browser.$("section[aria-label='导出存档']")).waitForDisplayed({ timeout: 30_000 });
  await clickButton("导出");
  setStage("receiving exported save");
  const gameSave = await browser.executeAsync(async (done) => {
    try {
      done({ ok: true, download: await window.__RUSTYERA_TEST__.takeDownload(30_000) });
    } catch (error) {
      done({ ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
    }
  });
  if (!gameSave.ok) throw new Error(`in-game save export failed: ${gameSave.error}`);
  if (
    gameSave.download.name !== "save00.sav" ||
    gameSave.download.bytes.length === 0 ||
    JSON.stringify(gameSave.download.bytes.slice(0, 4)) !== JSON.stringify([0xef, 0xbb, 0xbf, 0x34])
  ) {
    throw new Error(`in-game save is empty or malformed: ${JSON.stringify(gameSave.download)}`);
  }
  await browser.execute((bytes) => {
    const nativeInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file" || this.webkitdirectory || !this.accept.includes(".sav")) {
        nativeInputClick.call(this);
        return;
      }
      const file = new File([Uint8Array.from(bytes)], "generated.sav", {
        type: "application/octet-stream",
      });
      Object.defineProperty(this, "files", { configurable: true, value: [file] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
      HTMLInputElement.prototype.click = nativeInputClick;
    };
  }, gameSave.download.bytes);
  await clickFileMenuAction(browser, "导入存档…");
  await (await browser.$("section[aria-label='导入存档']")).waitForDisplayed({ timeout: 30_000 });
  await clickButton("选择 .sav 文件…");
  setStage("waiting for imported save selection");
  await browser.waitUntil(
    async () =>
      (await browser.$("section[aria-label='导入存档']").getText()).includes("generated.sav"),
    { timeout: 30_000, interval: 100, timeoutMsg: "traditional save file was not selected" },
  );
  const importSlot = await browser.$("section[aria-label='导入存档'] select");
  await importSlot.selectByVisibleText("槽位 01（空）");
  await clickButton("导入");
  setStage("waiting for save import");
  const imported = await browser
    .waitUntil(
      () =>
        browser.execute(() => {
          const transfer = window.__RUSTYERA_TEST__?.snapshot().saveTransfer;
          return transfer?.mode == null && !transfer.busy && !transfer.error;
        }),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "traditional save was not imported",
      },
    )
    .then(() => true)
    .catch(() => false);
  if (!imported) {
    const diagnosis = await browser.execute(() => ({
      status: document.querySelector(".runtime-status")?.textContent,
      dialog: document.querySelector("section[aria-label='导入存档']")?.textContent,
      selectedSlot: document.querySelector("section[aria-label='导入存档'] select")?.value,
      state: window.__RUSTYERA_TEST__?.snapshot(),
    }));
    throw new Error(`traditional save was not imported: ${JSON.stringify(diagnosis)}`);
  }
  await clickFileMenuAction(browser, "导出存档…");
  await (await browser.$("section[aria-label='导出存档']")).waitForDisplayed({ timeout: 30_000 });
  const exportSlot = await browser.$("section[aria-label='导出存档'] select");
  await exportSlot.selectByVisibleText("槽位 01（已有存档）");
  await clickButton("导出");
  setStage("receiving round-trip save");
  await browser.waitUntil(
    () => browser.execute(() => window.__RUSTYERA_TEST_DOWNLOADS__?.[0]?.name === "save01.sav"),
    { timeout: 10_000, interval: 100, timeoutMsg: "round-trip save download was not produced" },
  );
  const exportedSave = await browser.execute(() => {
    const download = window.__RUSTYERA_TEST_DOWNLOADS__?.shift();
    if (!download) return null;
    let hash = 0x811c9dc5;
    for (const byte of download.bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return {
      name: download.name,
      byteLength: download.bytes.length,
      signature: (hash >>> 0).toString(16).padStart(8, "0"),
    };
  });
  if (!exportedSave) throw new Error("traditional save export produced no download");
  const saveTransfer = {
    inGameSave: true,
    imported: true,
    exportedName: exportedSave.name,
    roundTrip: exportedSave.signature === byteSignature(gameSave.download.bytes),
    byteLength: exportedSave.byteLength,
  };
  if (saveTransfer.exportedName !== "save01.sav" || !saveTransfer.roundTrip) {
    throw new Error(`traditional save round trip mismatch: ${JSON.stringify(saveTransfer)}`);
  }
  let tooltip;
  if (checkTooltip) {
    const target = await browser.$("button[data-era-tooltip]");
    await target.waitForDisplayed({ timeout: 20_000 });
    await target.moveTo();
    const floating = await browser.$(".game-tooltip");
    await floating.waitForDisplayed({ timeout: 20_000 });
    tooltip = await browser.execute(() => {
      const element = document.querySelector(".game-tooltip");
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim(),
        role: element.getAttribute("role"),
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        visible: element.getClientRects().length > 0,
      };
    });
    if (
      !tooltip?.visible ||
      tooltip.text !== "button tip\nsecond line" ||
      tooltip.role !== "tooltip"
    ) {
      throw new Error(`tooltip rendering mismatch: ${JSON.stringify(tooltip)}`);
    }
  }
  setStage("collecting final compatibility report");
  const observed = await browser.execute(() => ({
    userAgent: navigator.userAgent,
    status: document.querySelector(".runtime-status")?.textContent,
    output: document.querySelector(".game-viewport")?.textContent,
    picker: window.__RUSTYERA_COMPAT_PICKER__,
    startupTelemetry: window.__RUSTYERA_TEST__?.snapshot().startupTelemetry,
  }));
  assertColdStartup(observed.startupTelemetry);
  if (!observed.picker?.fallback || !observed.picker.focusBeforeChange) {
    throw new Error(
      `portable directory picker was not exercised: ${JSON.stringify(observed.picker)}`,
    );
  }
  if (browserName === "safari") {
    setStage("minimizing Safari automation window");
    minimized = await browser
      .minimizeWindow()
      .then(() => true)
      .catch(() => false);
  }
  console.log(
    JSON.stringify({
      browser: browserName,
      browserVersion: browser.capabilities.browserVersion,
      minimized,
      projectName: setup.projectName,
      opfs: setup.opfs,
      opfsReset,
      startupGuidance,
      projectProgress,
      fontAccess,
      operationSequence,
      saveTransfer,
      tooltip,
      ...observed,
    }),
  );
}
