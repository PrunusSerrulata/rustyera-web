import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ClientPreferencesDialog from "@/components/ClientPreferencesDialog.vue";
import { defaultPreferences, type ProjectConfigurationEntry } from "@/core/types";

async function setCheckbox(selector: string, checked: boolean): Promise<void> {
  const checkbox = document.body.querySelector<HTMLInputElement>(selector)!;
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}

describe("client preferences dialog", () => {
  afterEach(() => document.body.replaceChildren());

  it("edits sparse global and project overrides independently, including fixed project fields", async () => {
    const entry: ProjectConfigurationEntry = {
      code: "UseMouse",
      japanese: "マウスを使用する",
      english: "Use mouse",
      value: "NO",
      kind: "boolean",
      allowed: [],
      fixed: true,
      applicability: 12,
      default_value: "YES",
      effective_value: "NO",
      application: "hot",
      preference_eligible: true,
      client_effective_value: "NO",
    };
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {} },
        entries: [entry],
        projectWritable: true,
      },
    });

    const useMouseLabel = document.body.querySelector<HTMLLabelElement>(
      "label[title='允许使用鼠标点击游戏按钮并提交交互。']",
    );
    expect(useMouseLabel?.getAttribute("aria-description")).toBe(
      "允许使用鼠标点击游戏按钮并提交交互。",
    );
    expect(document.body.querySelectorAll("fieldset.settings-group")).toHaveLength(2);
    await setCheckbox("#preference-global-UseMouse-override", true);
    await setCheckbox("#preference-global-UseMouse", true);
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "global",
      expect.objectContaining({ settings: { UseMouse: "YES" } }),
    ]);
  });

  it("restores each scope draft and saves project auxiliary overrides sparsely", async () => {
    const entry: ProjectConfigurationEntry = {
      code: "UseMouse",
      japanese: "マウスを使用する",
      english: "Use mouse",
      value: "YES",
      kind: "boolean",
      allowed: [],
      fixed: true,
      applicability: 12,
      default_value: "YES",
      effective_value: "YES",
      application: "hot",
      preference_eligible: true,
      client_effective_value: "NO",
    };
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: {
          settings: { UseMouse: "NO" },
          imageScale: 1.5,
          masterVolume: 0.4,
          trustProjectFileMetadata: true,
        },
        entries: [entry],
        projectWritable: true,
      },
    });
    const tabs = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs.find((tab) => tab.textContent?.includes("项目偏好"))!.click();
    await wrapper.vm.$nextTick();

    await setCheckbox("#preference-project-UseMouse-override", false);
    tabs.find((tab) => tab.textContent?.includes("全局偏好"))!.click();
    await wrapper.vm.$nextTick();
    tabs.find((tab) => tab.textContent?.includes("项目偏好"))!.click();
    await wrapper.vm.$nextTick();
    const restoredOverride = document.body.querySelector<HTMLInputElement>(
      "#preference-project-UseMouse-override",
    )!;
    expect(restoredOverride.checked).toBe(true);

    await setCheckbox("#preference-project-UseMouse-override", false);
    for (const id of [
      "#preference-project-imageScale-override",
      "#preference-project-trustProjectFileMetadata-override",
    ]) {
      await setCheckbox(id, false);
    }
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "project",
      {
        settings: {},
        imageScale: undefined,
        masterVolume: 0.4,
        trustProjectFileMetadata: undefined,
        interactionAssistMode: undefined,
      },
    ]);
  });

  it("edits a global interaction panel mode and a sparse project override", async () => {
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {} },
        entries: [],
        projectWritable: true,
      },
    });

    const globalModes = document.body.querySelectorAll<HTMLInputElement>(
      "input[name='preference-global-interactionAssistMode']",
    );
    expect([...globalModes].map((option) => option.parentElement?.textContent?.trim())).toEqual([
      "关闭",
      "开启",
      "自动",
    ]);
    await setCheckbox("#preference-global-interactionAssistMode-on", true);
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(wrapper.emitted("save")?.at(-1)?.[1]).toMatchObject({ interactionAssistMode: "on" });

    const projectTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.includes("项目偏好"),
    )!;
    projectTab.click();
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector("#preference-project-interactionAssistMode")).toBeNull();
    await setCheckbox("#preference-project-interactionAssistMode-override", true);
    await setCheckbox("#preference-project-interactionAssistMode-off", true);
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(wrapper.emitted("save")?.at(-1)?.[1]).toMatchObject({ interactionAssistMode: "off" });
  });

  it("keeps numeric project-setting overrides as protocol strings", async () => {
    const entry: ProjectConfigurationEntry = {
      code: "FontSize",
      japanese: "フォントサイズ",
      english: "Font size",
      value: "18",
      kind: "integer",
      allowed: [],
      fixed: false,
      applicability: 12,
      default_value: "18",
      effective_value: "18",
      application: "hot",
      preference_eligible: true,
      client_effective_value: "18",
    };
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {} },
        entries: [entry],
        projectWritable: true,
      },
    });

    await setCheckbox("#preference-global-FontSize-override", true);
    const input = document.body.querySelector<HTMLInputElement>("#preference-global-FontSize")!;
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "global",
      expect.objectContaining({ settings: { FontSize: "20" } }),
    ]);
  });

  it("offers the project-settings editable font list for client preferences", async () => {
    const entry: ProjectConfigurationEntry = {
      code: "FontName",
      japanese: "フォント名",
      english: "Font name",
      value: "Alpha Sans",
      kind: "string",
      allowed: [],
      fixed: false,
      applicability: 12,
      default_value: "Alpha Sans",
      effective_value: "Alpha Sans",
      application: "hot",
      preference_eligible: true,
      client_effective_value: "Alpha Sans",
    };
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {} },
        entries: [entry],
        fontFamilies: ["Alpha Sans", "Beta Serif"],
        fontAccessStatus: "denied",
        projectWritable: true,
      },
    });

    await setCheckbox("#preference-global-FontName-override", true);
    const input = document.body.querySelector<HTMLInputElement>("#preference-global-FontName")!;
    expect(input.type).toBe("text");
    expect(input.getAttribute("list")).toBe("available-game-fonts");
    expect(input.getAttribute("aria-describedby")).toBe(
      "preference-global-FontName-font-access-status",
    );
    expect(
      [...document.body.querySelectorAll("#available-game-fonts option")].map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(["Alpha Sans", "Beta Serif"]);

    input.value = "Manually Entered Font";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(input.value).toBe("Manually Entered Font");
    const retry = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "重试",
    )!;
    retry.click();
    expect(wrapper.emitted("requestFonts")).toHaveLength(1);

    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "global",
      expect.objectContaining({ settings: { FontName: "Manually Entered Font" } }),
    ]);
  });

  it("falls back to global scope when project preferences are read-only", async () => {
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: { UseMouse: "NO" } },
        entries: [],
        projectWritable: false,
      },
    });
    const projectTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.includes("项目偏好"),
    )!;
    expect(projectTab.disabled).toBe(true);

    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)?.[0]).toBe("global");
  });

  it("keeps global client preferences editable without project configuration", async () => {
    const wrapper = mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {} },
        entries: [],
        projectWritable: false,
      },
    });

    const imageScale = document.body.querySelector<HTMLInputElement>(
      "#preference-global-imageScale",
    )!;
    const imageScaleItem = imageScale.closest(".setting-item")!;
    expect(imageScale.disabled).toBe(false);
    expect(imageScaleItem.classList.contains("preference-image-scale-setting")).toBe(true);
    expect(imageScaleItem.querySelector("label")?.title).toBe(
      "调整游戏图片和画布在当前客户端中的显示缩放比例。",
    );
    expect(imageScaleItem.querySelector(":scope > .preference-setting-control")).not.toBeNull();
    const useMouseOverride = document.body.querySelector<HTMLInputElement>(
      "#preference-global-UseMouse-override",
    )!;
    const useMouseStatus = useMouseOverride.closest("label")!.querySelector("small")!;
    expect(useMouseStatus.textContent).toBe("继承");
    expect(useMouseOverride.disabled).toBe(false);
    await setCheckbox("#preference-global-UseMouse-override", true);
    expect(useMouseStatus.textContent).toBe("已覆盖");
    expect(document.body.querySelector("#preference-global-masterVolume")).toBeNull();
    imageScale.value = "1.5";
    imageScale.dispatchEvent(new Event("input", { bubbles: true }));
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "global",
      expect.objectContaining({ settings: { UseMouse: "YES" }, imageScale: 1.5 }),
    ]);
  });

  it("lays out override controls without overlap and removes the master volume item", async () => {
    const entries = Object.entries({
      WindowMaximixed: "NO",
      WindowX: "760",
      WindowY: "480",
      FontName: "ＭＳ ゴシック",
      FontSize: "18",
      LineHeight: "19",
      ForeColor: "192,192,192",
      BackColor: "0,0,0",
      FocusColor: "255,255,0",
      AudioVolume: "100",
      ReplaceFullWidthSpaces: "NO",
    }).map(([code, value]): ProjectConfigurationEntry => ({
      code,
      japanese: code,
      english: code,
      value,
      kind: "string",
      allowed: [],
      fixed: false,
      applicability: 12,
      default_value: value,
      effective_value: value,
      application: "hot",
      preference_eligible: true,
      client_effective_value: value,
    }));
    mount(ClientPreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        globalValue: defaultPreferences(),
        projectValue: { settings: {}, masterVolume: 0.4 },
        entries,
        projectWritable: true,
      },
    });

    const item = (code: string) =>
      document.body
        .querySelector(`#preference-global-${code}-override`)
        ?.closest<HTMLElement>(".setting-item");
    expect(item("WindowMaximixed")?.classList.contains("setting-wide")).toBe(true);
    expect(item("WindowX")?.classList.contains("setting-wide")).toBe(false);
    expect(item("WindowY")?.classList.contains("setting-wide")).toBe(false);
    expect(item("FontName")?.classList.contains("setting-wide")).toBe(true);
    expect(item("FontSize")?.classList.contains("setting-wide")).toBe(false);
    expect(item("LineHeight")?.classList.contains("setting-wide")).toBe(false);
    expect(item("AudioVolume")?.classList.contains("setting-wide")).toBe(true);

    const longNameItem = item("ReplaceFullWidthSpaces")!;
    expect(longNameItem.querySelector(".preference-setting-control")).toBeNull();
    await setCheckbox("#preference-global-ReplaceFullWidthSpaces-override", true);
    expect(longNameItem.querySelector(".preference-setting-control")).not.toBeNull();

    for (const code of ["ForeColor", "BackColor", "FocusColor"]) {
      const colorItem = item(code)!;
      expect(colorItem.classList.contains("preference-color-setting")).toBe(true);
      expect(colorItem.querySelector(".preference-setting-control")).not.toBeNull();
    }
    const metadata = document.body.querySelector<HTMLElement>(".preference-metadata-setting")!;
    expect(metadata.classList.contains("setting-wide")).toBe(true);
    expect(metadata.querySelector(".preference-boolean-control")).not.toBeNull();
    expect(document.body.textContent).not.toContain("主音量");
    expect(document.body.querySelector("[id*='masterVolume']")).toBeNull();
  });
});
