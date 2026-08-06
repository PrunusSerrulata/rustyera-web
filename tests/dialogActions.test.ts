import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences } from "@/core/types";

const debugCommand = vi.hoisted(() => vi.fn(async () => {}));
const closeDebugDialog = vi.hoisted(() => vi.fn());
const debugStore = reactive({
  debugConsoleOpen: true,
  variablesOpen: true,
  stackOpen: true,
  debugStop: {
    stop: { program_generation: 1, pause_epoch: 2 },
    selected_fiber: 7,
  },
  debugOutput: [],
  debugVariables: [] as any[],
  debugFibers: [],
  debugFrames: [],
  debugVariableValues: {},
  gameInteractionsBlocked: false,
  debugCommand,
  closeDebugDialog,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => debugStore }));

import DebugDialogs from "@/components/DebugDialogs.vue";
import ColorPickerDialog from "@/components/ColorPickerDialog.vue";
import LogDialog from "@/components/LogDialog.vue";
import OpenProjectDialog from "@/components/OpenProjectDialog.vue";
import PreferencesDialog from "@/components/PreferencesDialog.vue";

describe("dialog actions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    closeDebugDialog.mockImplementation((kind: "console" | "variables" | "stack") => {
      if (kind === "console") debugStore.debugConsoleOpen = false;
      else if (kind === "variables") debugStore.variablesOpen = false;
      else debugStore.stackOpen = false;
    });
    debugStore.debugConsoleOpen = true;
    debugStore.variablesOpen = true;
    debugStore.stackOpen = true;
    debugStore.debugStop = {
      stop: { program_generation: 1, pause_epoch: 2 },
      selected_fiber: 7,
    };
  });

  it("applies all tab drafts together and resets only the active tab", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: { ...defaultPreferences(), fontSizeOverridePx: 24 },
        fonts: ["Project Font"],
        hostKind: "tauri",
        configurationEntries: [
          {
            code: "FontSize",
            japanese: "フォントサイズ",
            english: "Font size",
            value: "12",
            kind: "integer",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "18",
            effective_value: "12",
            application: "hot",
          },
          {
            code: "UseMouse",
            japanese: "マウスを使用する",
            english: "Use mouse",
            value: "YES",
            kind: "boolean",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "YES",
            effective_value: "YES",
            application: "hot",
          },
        ],
      },
    });

    await clickButton("显示");
    await clickButton("重置当前标签页");
    const projectInput = document.body.querySelector<HTMLInputElement>("#setting-FontSize")!;
    projectInput.value = "18";
    projectInput.dispatchEvent(new Event("input", { bubbles: true }));
    await clickButton("交互与输出");
    const useMouse = document.body.querySelector<HTMLInputElement>("#setting-UseMouse")!;
    useMouse.checked = false;
    useMouse.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    await clickButton("应用");
    expect(wrapper.emitted("save")?.at(-1)?.[0]).toMatchObject({ fontSizeOverridePx: 24 });
    expect(wrapper.emitted("save")?.at(-1)?.[1]).toEqual([
      { code: "FontSize", value: "18" },
      { code: "UseMouse", value: "NO" },
    ]);

    await clickButton("取消");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("treats a cleared accessibility font size as following the game configuration", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: { ...defaultPreferences(), fontSizeOverridePx: 24 },
        fonts: [],
        hostKind: "browser",
      },
    });
    const input = document.body.querySelector<HTMLInputElement>("#client-font-size")!;

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await clickButton("应用");

    expect(wrapper.emitted("save")?.at(-1)?.[0]).toMatchObject({ fontSizeOverridePx: null });
    wrapper.unmount();
  });

  it("shows browser viewport data and synchronizes the 216-color palette with HEX input", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: defaultPreferences(),
        fonts: [],
        hostKind: "browser",
        viewportMeasurement: {
          width: 900,
          height: 600,
          lineColumns: 100,
          chromeWidth: 0,
          chromeHeight: 0,
        },
        configurationEntries: [
          {
            code: "ForeColor",
            japanese: "文字色",
            english: "Text color",
            value: "192,192,192",
            kind: "color",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "192,192,192",
            effective_value: "192,192,192",
            application: "hot",
          },
        ],
      },
    });

    await clickButton("显示");
    expect(document.body.textContent).toContain("900");
    await clickButton("192,192,192");
    expect(document.body.querySelectorAll(".palette-swatch")).toHaveLength(216);
    expect(document.body.textContent).not.toContain("常用颜色");
    const hex = document.body.querySelector<HTMLInputElement>(".color-hex input")!;
    hex.value = "#336699";
    hex.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await clickButton("确定");
    expect(document.body.querySelector("#setting-ForeColor")?.textContent).toContain("51,102,153");
    wrapper.unmount();
  });

  it("keeps invalid color edits visible and disables confirmation", async () => {
    const wrapper = mount(ColorPickerDialog, {
      attachTo: document.body,
      props: { open: true, value: "1,2,3", title: "选择颜色" },
    });
    const hex = document.body.querySelector<HTMLInputElement>(".color-hex input")!;
    hex.value = "#12";
    hex.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(hex.value).toBe("#12");
    expect(document.body.textContent).toContain("#RRGGBB");
    expect(
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "确定",
      )?.disabled,
    ).toBe(true);
    await clickButton("取消");
    expect(wrapper.emitted("confirm")).toBeUndefined();
    wrapper.unmount();
  });

  it("warns before opening another project and exposes both choices", async () => {
    const wrapper = mount(OpenProjectDialog, {
      attachTo: document.body,
      props: { open: true },
    });

    expect(document.body.textContent).toContain("会丢失当前游戏中尚未保存的进度");
    await clickButton("取消");
    await clickButton("打开新项目");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    wrapper.unmount();
  });

  it("executes both debug commands and closes every debug dialog", async () => {
    const wrapper = mount(DebugDialogs, { attachTo: document.body });
    const input = document.body.querySelector<HTMLInputElement>(".debug-input")!;

    input.value = "1 + 1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await clickButton("求值");
    input.value = "RESULT = 2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await clickButton("安全执行");

    expect(debugCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: expect.objectContaining({ type: "evaluate" }) }),
    );
    expect(debugCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: expect.objectContaining({ type: "execute_safe" }) }),
    );

    expect(debugCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "console",
        stop: expect.objectContaining({ pause_epoch: 2 }),
      }),
    );

    debugStore.debugVariables = [
      {
        symbol_key: [1],
        name: "RESULT",
        storage: "global",
        value_kind: "integer",
        dimensions: [100, 200],
      },
    ];
    await nextTick();
    document.body
      .querySelector<HTMLElement>(".debug-table tbody tr")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(debugCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "read_variable",
        value: expect.objectContaining({ indices: [0, 0] }),
      }),
    );

    for (const dialog of document.body.querySelectorAll<HTMLElement>("[role='dialog']")) {
      dialog.querySelector<HTMLButtonElement>("[aria-label='关闭']")!.click();
    }
    expect(debugStore.debugConsoleOpen).toBe(false);
    expect(debugStore.variablesOpen).toBe(false);
    expect(debugStore.stackOpen).toBe(false);
    expect(closeDebugDialog).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("copies, exports, clears, and closes the log dialog", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const createObjectURL = vi.fn(() => "blob:log");
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 480,
    });
    const wrapper = mount(LogDialog, {
      attachTo: document.body,
      props: {
        open: true,
        entries: [{ timestamp: new Date("2026-01-01T00:00:00Z"), level: "info", message: "ready" }],
      },
    });
    await nextTick();
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await nextTick();

    expect(document.body.querySelector<HTMLUListElement>(".log-list")!.scrollTop).toBe(480);
    expect(document.body.querySelector("ol.log-list")).toBeNull();
    expect(document.body.querySelector(".log-list li")!.textContent).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] INFO {2}ready$/,
    );
    expect(document.body.querySelector(".log-list time")).not.toBeNull();
    expect(document.body.querySelector(".log-list .log-level")?.textContent).toBe("INFO ");

    await clickButton("复制");
    await clickButton("导出");
    await clickButton("清空");
    document.body.querySelector<HTMLButtonElement>("[aria-label='关闭']")!.click();

    expect(writeText).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(wrapper.emitted("clear")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    else delete (HTMLElement.prototype as any).scrollHeight;
  });
});

async function clickButton(label: string): Promise<void> {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `missing ${label} button`).toBeDefined();
  button!.click();
  await nextTick();
}
