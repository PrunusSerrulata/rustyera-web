import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import ClientPreferencesDialog from "@/components/ClientPreferencesDialog.vue";
import { defaultPreferences, type ProjectConfigurationEntry } from "@/core/types";

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

    const controls = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    controls[0]!.checked = true;
    controls[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    controls[1]!.checked = true;
    controls[1]!.dispatchEvent(new Event("change", { bubbles: true }));
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

    const override = [...document.body.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent?.includes("覆盖 启用鼠标操作"))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    override.click();
    tabs.find((tab) => tab.textContent?.includes("全局偏好"))!.click();
    await wrapper.vm.$nextTick();
    tabs.find((tab) => tab.textContent?.includes("项目偏好"))!.click();
    await wrapper.vm.$nextTick();
    const restoredOverride = [...document.body.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent?.includes("覆盖 启用鼠标操作"))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(restoredOverride.checked).toBe(true);

    restoredOverride.click();
    for (const labelText of ["图片缩放", "主音量", "覆盖快速启动文件元数据策略"]) {
      const checkbox = [...document.body.querySelectorAll<HTMLLabelElement>("label")]
        .find((label) => label.textContent?.includes(labelText))!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      checkbox.click();
    }
    document.body
      .querySelector<HTMLFormElement>("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(wrapper.emitted("save")?.at(-1)).toEqual([
      "project",
      {
        settings: {},
        imageScale: undefined,
        masterVolume: undefined,
        trustProjectFileMetadata: undefined,
      },
    ]);
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

    document.body.querySelector<HTMLInputElement>("#preference-global-FontSize-override")!.click();
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
});
