/* global document, HTMLInputElement, HTMLElement, navigator, window */

import path from "node:path";

import { applyBackgroundDomInput } from "./dom-test-input.mjs";
import { portableFileBatches } from "./browser-compat-support.mjs";

export function createBrowserCompatibilityHelpers({
  browserName,
  backgroundDom,
  nativeDriverInputs,
  setStage,
}) {
  async function installPackagedProjectPicker(activeBrowser, selectedProjectFile, browserFetchUrl) {
    return activeBrowser.executeAsync(
      async (projectName, projectUrl, done) => {
        try {
          const nativeCreateElement = document.createElement;
          const pickerDescriptor = Object.getOwnPropertyDescriptor(window, "showOpenFilePicker");
          const fetchController = new AbortController();
          const picker = {
            fallback: true,
            focusBeforeChange: false,
            attempts: [],
            browserFetch: Boolean(projectUrl),
            injected: false,
            error: null,
          };
          const restoreCreateElement = () => {
            document.createElement = nativeCreateElement;
          };
          window.__RUSTYERA_COMPAT_PICKER_CLEANUP__ = () => {
            fetchController.abort();
            restoreCreateElement();
            if (pickerDescriptor)
              Object.defineProperty(window, "showOpenFilePicker", pickerDescriptor);
            else delete window.showOpenFilePicker;
          };
          Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            value: undefined,
          });
          document.createElement = function (tagName, options) {
            const element = nativeCreateElement.call(this, tagName, options);
            if (!(element instanceof HTMLInputElement)) return element;
            const nativeClick = element.click.bind(element);
            Object.defineProperty(element, "click", {
              configurable: true,
              value() {
                const isProjectFilePicker =
                  element.type === "file" &&
                  !element.multiple &&
                  element.accept.includes(".reraproj");
                picker.attempts.push({
                  accept: element.accept,
                  isProjectFilePicker,
                  multiple: element.multiple,
                  type: element.type,
                });
                if (!isProjectFilePicker) {
                  nativeClick();
                  return;
                }
                picker.focusBeforeChange = true;
                window.dispatchEvent(new Event("focus"));
                if (projectUrl) {
                  void fetch(projectUrl, { signal: fetchController.signal })
                    .then((response) => {
                      if (!response.ok) throw new Error(`HTTP ${response.status}`);
                      return response.arrayBuffer();
                    })
                    .then((bytes) => {
                      const file = new File([bytes], projectName, {
                        type: "application/octet-stream",
                      });
                      Object.defineProperty(element, "files", {
                        configurable: true,
                        value: [file],
                      });
                      element.dispatchEvent(new Event("change", { bubbles: true }));
                      picker.injected = true;
                      restoreCreateElement();
                    })
                    .catch((error) => {
                      if (error?.name !== "AbortError") picker.error = String(error);
                    });
                  return;
                }
                element.addEventListener("change", restoreCreateElement, { once: true });
              },
            });
            return element;
          };
          window.__RUSTYERA_COMPAT_PICKER__ = picker;
          done({
            ok: true,
            projectName,
            opfs: typeof navigator.storage.getDirectory === "function",
          });
        } catch (error) {
          done({
            ok: false,
            error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
          });
        }
      },
      path.basename(selectedProjectFile),
      browserFetchUrl,
    );
  }

  async function installPortableProjectPicker(activeBrowser, selectedProject, files) {
    await activeBrowser.execute(() => {
      window.__RUSTYERA_COMPAT_SELECTED__ = [];
      window.__RUSTYERA_COMPAT_PAYLOADS__ = new Map();
      window.__RUSTYERA_COMPAT_BATCH__ = 0;
    });
    const projectName = path.basename(selectedProject);
    for (const batch of portableFileBatches(files)) {
      await activeBrowser.execute(
        (entries, selectedProjectName) => {
          const selected = window.__RUSTYERA_COMPAT_SELECTED__;
          const payloads = window.__RUSTYERA_COMPAT_PAYLOADS__;
          for (const entry of entries) {
            const chunks = payloads.get(entry.path) ?? [];
            const raw = atob(entry.base64);
            chunks.push(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
            if (!entry.final) {
              payloads.set(entry.path, chunks);
              continue;
            }
            payloads.delete(entry.path);
            const file = new File(chunks, entry.path.split("/").at(-1));
            Object.defineProperty(file, "webkitRelativePath", {
              value: `${selectedProjectName}/${entry.path}`,
            });
            selected.push(file);
          }
          window.__RUSTYERA_COMPAT_BATCH__ += 1;
          document.documentElement.dataset.rustyeraTestFileBatch = `${window.__RUSTYERA_COMPAT_BATCH__}:${selected.length}:${payloads.size}`;
        },
        batch,
        projectName,
      );
    }
    return activeBrowser.executeAsync(
      async (selectedProjectName, allowFocusEvent, done) => {
        try {
          const selected = window.__RUSTYERA_COMPAT_SELECTED__;
          const nativeCreateElement = document.createElement;
          const pickerDescriptor = Object.getOwnPropertyDescriptor(window, "showDirectoryPicker");
          const picker = {
            fallback: false,
            focusBeforeChange: false,
            confirmationDelayMs: 50,
            attempts: [],
          };
          const restoreCreateElement = () => {
            document.createElement = nativeCreateElement;
          };
          window.__RUSTYERA_COMPAT_PICKER_CLEANUP__ = () => {
            restoreCreateElement();
            if (pickerDescriptor)
              Object.defineProperty(window, "showDirectoryPicker", pickerDescriptor);
            else delete window.showDirectoryPicker;
          };
          Object.defineProperty(window, "showDirectoryPicker", {
            configurable: true,
            value: undefined,
          });
          document.createElement = function (tagName, options) {
            const element = nativeCreateElement.call(this, tagName, options);
            if (!(element instanceof HTMLInputElement)) return element;
            const nativeClick = element.click.bind(element);
            Object.defineProperty(element, "click", {
              configurable: true,
              value() {
                const isDirectoryPicker =
                  element.type === "file" && element.multiple && !element.accept;
                picker.attempts.push({
                  accept: element.accept,
                  directoryAttribute: element.hasAttribute("webkitdirectory"),
                  directoryProperty: Boolean(element.webkitdirectory),
                  isDirectoryPicker,
                  multiple: element.multiple,
                  type: element.type,
                });
                if (!isDirectoryPicker) {
                  nativeClick();
                  return;
                }
                picker.fallback = true;
                if (allowFocusEvent) {
                  window.dispatchEvent(new Event("focus"));
                  picker.focusBeforeChange = true;
                }
                window.setTimeout(() => {
                  Object.defineProperty(element, "files", { configurable: true, value: selected });
                  element.dispatchEvent(new Event("change", { bubbles: true }));
                  restoreCreateElement();
                }, picker.confirmationDelayMs);
              },
            });
            return element;
          };
          window.__RUSTYERA_COMPAT_PICKER__ = picker;
          delete document.documentElement.dataset.rustyeraTestFileBatch;
          delete window.__RUSTYERA_COMPAT_BATCH__;
          delete window.__RUSTYERA_COMPAT_PAYLOADS__;
          done({
            ok: true,
            projectName: selectedProjectName,
            opfs: typeof navigator.storage.getDirectory === "function",
          });
        } catch (error) {
          done({
            ok: false,
            error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
          });
        }
      },
      projectName,
      !backgroundDom,
    );
  }

  async function exerciseProjectPreferencesDuringLoad(activeBrowser) {
    setStage("waiting for packaged project preference availability");
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute(() => {
          const state = window.__RUSTYERA_TEST__?.snapshot();
          return state?.projectOpen === true && state?.projectLoading === true;
        }),
      {
        timeout: 30_000,
        interval: 25,
        timeoutMsg: "project preferences did not become available during project loading",
      },
    );
    await clickFileMenuAction(activeBrowser, "偏好设置…");
    const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
    await dialog.waitForDisplayed({ timeout: 5_000 });
    const projectTab = await dialog.$("#preference-tab-project");
    const projectTabEnabled = await projectTab.isEnabled();
    if (!projectTabEnabled) throw new Error("project preference tab was disabled during loading");
    await clickElement(activeBrowser, projectTab);
    const field = await dialog.$("#preference-project-UseMouse-override");
    await field.waitForEnabled({ timeout: 5_000 });
    const projectFieldEditable = await field.isEnabled();
    if (!(await field.isSelected())) await clickElement(activeBrowser, field);
    await clickElement(activeBrowser, await dialog.$("button=应用"));
    await dialog.waitForDisplayed({ reverse: true, timeout: 30_000 });
    return {
      observedLoading: true,
      dialogOpened: true,
      projectTabEnabled,
      projectFieldEditable,
      saveSubmitted: true,
      saveCompleted: true,
    };
  }

  async function verifyProjectPreferencesAfterLoad(activeBrowser) {
    setStage("verifying packaged project preferences after load");
    await clickFileMenuAction(activeBrowser, "偏好设置…");
    const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
    await dialog.waitForDisplayed({ timeout: 5_000 });
    const projectTab = await dialog.$("#preference-tab-project");
    const projectTabEnabled = await projectTab.isEnabled();
    if (!projectTabEnabled) throw new Error("project preference tab was disabled after game load");
    await clickElement(activeBrowser, projectTab);
    const field = await dialog.$("#preference-project-UseMouse-override");
    await field.waitForEnabled({ timeout: 5_000 });
    const projectFieldEditable = await field.isEnabled();
    const savedOverrideSelected = await field.isSelected();
    await clickElement(activeBrowser, await dialog.$("button=取消"));
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
    return { projectTabEnabled, projectFieldEditable, savedOverrideSelected };
  }

  async function inspectInteractionAssistPanel(activeBrowser) {
    const panel = await activeBrowser.$("section[aria-label='交互辅助面板']");
    await panel.waitForDisplayed({ timeout: 30_000 });
    const firstAction = await panel.$(".interaction-assist-action");
    await firstAction.waitForClickable({ timeout: 30_000 });
    const before = await activeBrowser.execute(() => {
      const viewport = document.querySelector(".game-viewport");
      return {
        height: viewport?.getBoundingClientRect().height,
        scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
      };
    });
    await clickElement(activeBrowser, await panel.$("button[aria-label='展开']"));
    const expanded = await activeBrowser.execute(() => {
      const viewport = document.querySelector(".game-viewport");
      const panel = document.querySelector("section[aria-label='交互辅助面板']");
      const actions = [...document.querySelectorAll(".interaction-assist-action")];
      return {
        viewportHeight: viewport?.getBoundingClientRect().height,
        viewportScrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
        panelHeight: panel?.getBoundingClientRect().height,
        actionCount: actions.length,
        firstLabel: actions[0]?.getAttribute("aria-label"),
        expanded: panel?.classList.contains("expanded"),
      };
    });
    if (
      !expanded.expanded ||
      expanded.actionCount < 1 ||
      !expanded.firstLabel ||
      Math.abs(expanded.viewportHeight - before.height) > 0.5 ||
      expanded.viewportScrollTop !== before.scrollTop ||
      expanded.panelHeight > before.height * 0.75 + 0.5
    ) {
      throw new Error(
        `interaction assistance panel geometry mismatch: ${JSON.stringify({ before, expanded })}`,
      );
    }
    await clickElement(activeBrowser, await panel.$("button[aria-label='折叠']"));
    return { before, expanded };
  }

  async function inspectAutomaticInteractionAssist(activeBrowser) {
    const original = await activeBrowser.getWindowSize();
    const desktop = {
      width: Math.max(1024, original.width),
      height: Math.max(800, original.height),
    };
    await activeBrowser.setWindowSize(desktop.width, desktop.height);
    const panel = await activeBrowser.$("section[aria-label='交互辅助面板']");
    await panel.waitForDisplayed({ reverse: true, timeout: 5_000 });

    const mobile = { width: 600, height: 800 };
    await activeBrowser.setWindowSize(mobile.width, mobile.height);
    await panel.waitForDisplayed({ timeout: 5_000 });
    const mobileState = await activeBrowser.execute(() => ({
      visible: document.querySelector("section[aria-label='交互辅助面板']")?.ariaHidden === "false",
    }));
    if (!mobileState.visible)
      throw new Error(
        `automatic interaction assistance did not enable on mobile: ${JSON.stringify(mobileState)}`,
      );

    await activeBrowser.setWindowSize(desktop.width, desktop.height);
    await panel.waitForDisplayed({ reverse: true, timeout: 5_000 });
    return { desktop, mobile, mobileState };
  }

  async function clickFileMenuAction(activeBrowser, label) {
    const menuButton = await activeBrowser.$("#menu-file");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      setStage(`opening 文件 menu for ${label} (attempt ${attempt})`);
      // Projects can hide the menu bar until hover. Safari may otherwise dispatch the click
      // while the 120 ms reveal transform is still moving the button under the pointer. Safari's
      // in-page click does not need pointer geometry, and SafariDriver moveTo can block its command
      // queue long enough to starve the complete-snapshot monitor.
      if (browserName !== "safari") {
        await menuButton.moveTo();
        await activeBrowser.pause(200);
      }
      await menuButton.waitForDisplayed({ timeout: 2_000 });
      if ((await menuButton.getAttribute("aria-expanded")) !== "true")
        await clickElement(activeBrowser, menuButton);
      const opened = await activeBrowser
        .waitUntil(
          () => menuButton.getAttribute("aria-expanded").then((value) => value === "true"),
          {
            timeout: 1_000,
            interval: 50,
          },
        )
        .then(() => true)
        .catch(() => false);
      if (!opened) continue;
      setStage(`clicking ${label}`);
      const action = await activeBrowser.$(
        `//button[@id='menu-file']/following-sibling::*[contains(@class,'menu-popup')]//button[normalize-space(.)=${JSON.stringify(label)}]`,
      );
      const displayed = await action
        .waitForDisplayed({ timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      if (!displayed) continue;
      await clickElement(activeBrowser, action);
      return;
    }
    throw new Error(`文件 menu action did not become clickable: ${label}`);
  }

  async function clickElement(activeBrowser, element) {
    if (backgroundDom) {
      const evidence = await activeBrowser.execute(applyBackgroundDomInput, element);
      console.log(
        JSON.stringify({ browser: browserName, type: "background-dom-input", ...evidence }),
      );
      return;
    }
    if (browserName === "safari" && !nativeDriverInputs) {
      await activeBrowser.execute((target) => {
        window.setTimeout(() => target.click(), 0);
      }, element);
      return;
    }
    await element.click();
  }

  async function enableGlobalInteractionAssist(activeBrowser) {
    await clickFileMenuAction(activeBrowser, "偏好设置…");
    const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
    await dialog.waitForDisplayed({ timeout: 5_000 });
    await clickElement(
      activeBrowser,
      await dialog.$("#preference-global-interactionAssistMode-on"),
    );
    await clickElement(activeBrowser, await dialog.$("button=应用"));
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute(
          () =>
            document.querySelector("section[aria-label='交互辅助面板']")?.ariaHidden === "false",
        ),
      { timeout: 5_000, interval: 50, timeoutMsg: "interaction assistance did not switch on" },
    );
  }

  async function verifyGlobalPreferencesBeforeProject(activeBrowser) {
    const openDialog = async () => {
      setStage("opening global preferences before project load");
      const button = await activeBrowser.$("#welcome-preferences");
      await button.waitForClickable({ timeout: 5_000 });
      await clickElement(activeBrowser, button);
      const dialog = await activeBrowser.$("section[aria-label='RustyEra Web · 偏好设置']");
      const opened = await dialog
        .waitForDisplayed({ timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        // SafariDriver can report a successful native element click without dispatching it when a
        // previous automation session left Safari in the background. Exercise the same mounted UI
        // control in-page before treating the missing dialog as a product failure.
        await activeBrowser.execute(() => document.querySelector("#welcome-preferences")?.click());
      }
      await dialog.waitForDisplayed({ timeout: 5_000 });
      return dialog;
    };

    let dialog = await openDialog();
    const projectTab = await dialog.$("#preference-tab-project");
    const imageScale = await dialog.$("#preference-global-imageScale");
    const interactionAssistMode = await dialog.$("#preference-global-interactionAssistMode-auto");
    const imageScaleLabel = await dialog.$("label[for='preference-global-imageScale']");
    if (await projectTab.isEnabled())
      throw new Error("project preferences were enabled without a project");
    if (!(await imageScale.isEnabled()))
      throw new Error("global image scale was disabled without a project");
    const tooltip = await imageScaleLabel.getAttribute("title");
    if (!tooltip) throw new Error("global image scale did not expose its explanatory tooltip");
    const fontOverride = await dialog.$("#preference-global-FontName-override");
    await clickElement(activeBrowser, fontOverride);
    const fontInput = await dialog.$("#preference-global-FontName");
    await fontInput.waitForDisplayed({ timeout: 5_000 });
    const fontInputDetails = {
      type: await fontInput.getAttribute("type"),
      list: await fontInput.getAttribute("list"),
      describedBy: await fontInput.getAttribute("aria-describedby"),
    };
    if (fontInputDetails.type !== "text" || fontInputDetails.list !== "available-game-fonts") {
      throw new Error(
        `global game font did not use the editable project-settings list: ${JSON.stringify(fontInputDetails)}`,
      );
    }
    await fontInput.setValue("RustyEra Compatibility Font");
    const typedFont = await fontInput.getValue();
    if (typedFont !== "RustyEra Compatibility Font")
      throw new Error(`global game font was not editable: ${typedFont}`);
    await clickElement(activeBrowser, fontOverride);

    setStage("saving global preferences before project load");
    await imageScale.setValue("1.25");
    if (!(await interactionAssistMode.isSelected()))
      await clickElement(activeBrowser, interactionAssistMode);
    await clickElement(activeBrowser, await dialog.$("button=应用"));
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
    await activeBrowser.waitUntil(
      () =>
        activeBrowser.execute(
          () => window.__RUSTYERA_TEST__?.snapshot().status === "全局偏好已应用",
        ),
      {
        timeout: 5_000,
        interval: 50,
        timeoutMsg: "global preferences were not saved before project load",
      },
    );

    dialog = await openDialog();
    const persisted = await (await dialog.$("#preference-global-imageScale")).getValue();
    const persistedInteractionAssistMode = (await (
      await dialog.$("#preference-global-interactionAssistMode-auto")
    ).isSelected())
      ? "auto"
      : "other";
    if (persisted !== "1.25")
      throw new Error(`global preferences did not reopen with the saved value: ${persisted}`);
    if (persistedInteractionAssistMode !== "auto")
      throw new Error(
        `global interaction assistance mode did not persist: ${persistedInteractionAssistMode}`,
      );
    await (await dialog.$("#preference-global-imageScale")).setValue("1");
    await clickElement(activeBrowser, await dialog.$("button=应用"));
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 });
    return {
      projectTabEnabled: false,
      imageScaleEditable: true,
      fontInputDetails,
      typedFont,
      persisted,
      persistedInteractionAssistMode,
      restored: "1",
      tooltip,
    };
  }

  return {
    installPackagedProjectPicker,
    installPortableProjectPicker,
    exerciseProjectPreferencesDuringLoad,
    verifyProjectPreferencesAfterLoad,
    inspectInteractionAssistPanel,
    inspectAutomaticInteractionAssist,
    clickFileMenuAction,
    clickElement,
    enableGlobalInteractionAssist,
    verifyGlobalPreferencesBeforeProject,
  };
}
