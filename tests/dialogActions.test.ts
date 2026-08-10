import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences, type ProjectConfigurationEntry } from "@/core/types";

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
import GameProgressLossDialog from "@/components/GameProgressLossDialog.vue";
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
        fontFamilies: ["Project Font"],
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
    expect(useMouse.parentElement?.firstElementChild).toBe(useMouse);
    expect(useMouse.nextElementSibling?.textContent).toBe("启用鼠标操作");
    expect(useMouse.parentElement?.getAttribute("title")).toBe(
      "允许使用鼠标点击游戏按钮并提交交互。",
    );
    expect(useMouse.parentElement?.getAttribute("title")).not.toBe("UseMouse");
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

  it("shows compact display rows and synchronizes the visual picker with HEX input", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: defaultPreferences(),
        fontFamilies: [],
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
            code: "WindowX",
            japanese: "ウィンドウ幅",
            english: "Window width",
            value: "900",
            kind: "integer",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "900",
            effective_value: "900",
            application: "hot",
          },
          {
            code: "WindowY",
            japanese: "ウィンドウ高さ",
            english: "Window height",
            value: "600",
            kind: "integer",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "600",
            effective_value: "600",
            application: "hot",
          },
          {
            code: "FontSize",
            japanese: "フォントサイズ",
            english: "Font size",
            value: "16",
            kind: "integer",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "16",
            effective_value: "16",
            application: "hot",
          },
          {
            code: "LineHeight",
            japanese: "行高",
            english: "Line height",
            value: "18",
            kind: "integer",
            allowed: [],
            fixed: false,
            applicability: 12,
            default_value: "18",
            effective_value: "18",
            application: "hot",
          },
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
    expect(document.body.textContent).not.toContain("客户端偏好");
    expect(document.body.querySelector("#setting-WindowX")?.closest(".settings-grid")).toBe(
      document.body.querySelector("#setting-WindowY")?.closest(".settings-grid"),
    );
    expect(document.body.querySelector("#setting-FontSize")?.closest(".settings-grid")).toBe(
      document.body.querySelector("#setting-LineHeight")?.closest(".settings-grid"),
    );
    expect(
      document.body
        .querySelector("#setting-ForeColor")
        ?.closest(".setting-item")
        ?.classList.contains("setting-wide"),
    ).toBe(true);
    await clickButton("192,192,192");
    const disk = document.body.querySelector<HTMLElement>(".color-disk")!;
    const brightness = document.body.querySelector<HTMLElement>(".color-brightness")!;
    expect(disk).not.toBeNull();
    expect(brightness).not.toBeNull();
    expect(document.body.querySelectorAll(".palette-swatch")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("常用颜色");
    expect(document.body.textContent).not.toMatch(/色相|饱和度|HSB/);
    const hex = document.body.querySelector<HTMLInputElement>(".color-hex input")!;
    vi.spyOn(disk, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 200));
    dispatchPointer(disk, 200, 100);
    await nextTick();
    expect(hex.value).toBe("#C00000");
    vi.spyOn(brightness, "getBoundingClientRect").mockReturnValue(rect(0, 0, 24, 300));
    dispatchPointer(brightness, 12, 0);
    await nextTick();
    expect(hex.value).toBe("#FF0000");
    hex.value = "#336699";
    hex.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await clickButton("确定");
    expect(document.body.querySelector("#setting-ForeColor")?.textContent).toContain("51,102,153");
    wrapper.unmount();
  });

  it("lays out the volume and Tauri viewport actions as full settings rows", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: defaultPreferences(),
        fontFamilies: [],
        hostKind: "tauri",
        viewportMeasurement: {
          width: 960,
          height: 640,
          lineColumns: 100,
          chromeWidth: 0,
          chromeHeight: 0,
        },
        configurationEntries: [
          configurationEntry("AudioVolume", "80", "integer"),
          configurationEntry("ReplaceContinuationBR", "<br>", "string"),
          configurationEntry("WindowMaximixed", "NO", "boolean"),
          configurationEntry("WindowX", "800", "integer"),
          configurationEntry("WindowY", "600", "integer"),
        ],
      },
    });

    const volume = document.body.querySelector<HTMLInputElement>("#setting-AudioVolume")!;
    expect(volume.type).toBe("range");
    const volumeItem = volume.closest(".setting-item");
    expect(volumeItem?.classList.contains("setting-wide")).toBe(true);
    const volumeLabel = volumeItem?.querySelector("label");
    expect(volumeLabel?.getAttribute("title")).toBe("调整游戏音频的输出音量，0 为静音。");
    expect(volumeLabel?.getAttribute("title")).not.toBe("AudioVolume");
    expect(volume.parentElement?.querySelector("output")?.textContent?.trim()).toBe("80%");
    volume.value = "42";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(volume.parentElement?.querySelector("output")?.textContent?.trim()).toBe("42%");

    await clickButton("项目加载");
    const continuation = document.body
      .querySelector("#setting-ReplaceContinuationBR")
      ?.closest(".setting-item");
    expect(continuation?.classList.contains("setting-wide")).toBe(true);
    expect(continuation?.classList.contains("long-label-setting")).toBe(true);

    await clickButton("显示");
    const maximize = document.body.querySelector("#setting-WindowMaximixed")!;
    const maximizeRow = maximize.closest(".setting-item")!;
    const maximizeLabel = maximize.closest("label")!;
    const viewportButton = findButton("使用当前主视口大小");
    expect(maximizeRow.classList.contains("viewport-actions-setting")).toBe(true);
    expect(viewportButton.closest(".setting-item")).toBe(maximizeRow);
    expect(maximizeRow.getAttribute("title")).toBeNull();
    expect(maximizeLabel.getAttribute("title")).toBe("启动桌面客户端时将主窗口最大化。");
    expect(viewportButton.title).toBe("将当前主视口宽高填入下方尺寸设置。");
    expect(viewportButton.title).not.toBe(maximizeLabel.getAttribute("title"));
    viewportButton.click();
    await nextTick();
    expect(document.body.querySelector<HTMLInputElement>("#setting-WindowX")?.value).toBe("960");
    expect(document.body.querySelector<HTMLInputElement>("#setting-WindowY")?.value).toBe("640");
    wrapper.unmount();
  });

  it("offers an editable system-font list and exposes permission progress", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: defaultPreferences(),
        fontFamilies: ["Alpha Sans", "Beta Serif"],
        fontAccessStatus: "loading",
        hostKind: "browser",
        configurationEntries: [configurationEntry("FontName", "Alpha Sans", "string")],
      },
    });

    await clickButton("显示");
    const input = document.body.querySelector<HTMLInputElement>("#setting-FontName")!;
    expect(input.type).toBe("text");
    expect(input.getAttribute("list")).toBe("available-game-fonts");
    expect(
      [...document.body.querySelectorAll("#available-game-fonts option")].map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(["Alpha Sans", "Beta Serif"]);
    expect(document.body.textContent).toContain("正在等待浏览器授权并读取系统字体");
    expect(input.closest(".setting-item")?.querySelector("label")?.getAttribute("title")).toBe(
      "设置游戏输出文本使用的字体名称。",
    );

    await wrapper.setProps({ fontAccessStatus: "denied" });
    const liveStatus = document.body.querySelector("[role='status']")!;
    const retry = liveStatus.closest(".font-access-status")?.querySelector("button");
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute("title")).toBeNull();
    expect(liveStatus.querySelector("button")).toBeNull();
    await clickButton("重试");
    expect(wrapper.emitted("requestFonts")).toHaveLength(1);

    input.value = "Manually Entered Font";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await clickButton("应用");
    expect(wrapper.emitted("save")?.at(-1)?.[1]).toEqual([
      { code: "FontName", value: "Manually Entered Font" },
    ]);
    wrapper.unmount();
  });

  it("edits only hot settings for the current project-file session", async () => {
    const hot = configurationEntry("FontSize", "16", "integer");
    const restart = {
      ...configurationEntry("AutoSave", "YES", "boolean"),
      application: "restart" as const,
    };
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: defaultPreferences(),
        fontFamilies: [],
        hostKind: "browser",
        configurationEntries: [hot, restart],
        configurationReadOnly: true,
        configurationSessionOnly: true,
      },
    });

    expect(document.body.textContent).toContain("无需重启的设置仅对当前会话有效，退出游戏后将丢失");
    expect(document.body.textContent).not.toContain("项目设置不可修改");
    await clickButton("显示");
    const fontSize = document.body.querySelector<HTMLInputElement>("#setting-FontSize")!;
    expect(fontSize.disabled).toBe(false);
    fontSize.value = "18";
    fontSize.dispatchEvent(new Event("input", { bubbles: true }));
    await clickButton("存档");
    expect(document.body.querySelector<HTMLInputElement>("#setting-AutoSave")!.disabled).toBe(true);
    expect(findButton("应用并重启").disabled).toBe(true);
    await clickButton("应用");
    expect(wrapper.emitted("save")?.at(-1)?.[1]).toEqual([{ code: "FontSize", value: "18" }]);
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

  it.each([
    ["restart", "重新开始游戏", "重新开始"],
    ["title", "返回标题", "返回标题"],
  ] as const)(
    "warns before the %s action and exposes both choices",
    async (action, title, label) => {
      const returnTarget = document.createElement("button");
      returnTarget.id = "menu-file";
      document.body.append(returnTarget);

      const cancelWrapper = mount(GameProgressLossDialog, {
        attachTo: document.body,
        props: { action: null },
      });
      returnTarget.focus();
      await cancelWrapper.setProps({ action });

      const dialog = document.body.querySelector(`[role='dialog'][aria-label='${title}']`);
      expect(dialog?.textContent).toContain("可能会丢失尚未保存的游戏进度");
      await clickButton("取消");
      expect(cancelWrapper.emitted("cancel")).toHaveLength(1);
      await cancelWrapper.setProps({ action: null });
      await nextTick();
      expect(document.activeElement).toBe(returnTarget);
      cancelWrapper.unmount();

      const confirmWrapper = mount(GameProgressLossDialog, {
        attachTo: document.body,
        props: { action: null },
      });
      returnTarget.focus();
      await confirmWrapper.setProps({ action });
      await clickButton(label);
      expect(confirmWrapper.emitted("confirm")).toHaveLength(1);
      await confirmWrapper.setProps({ action: null });
      await nextTick();
      expect(document.activeElement).toBe(returnTarget);
      confirmWrapper.unmount();
      returnTarget.remove();
    },
  );

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
  const button = findButton(label);
  expect(button, `missing ${label} button`).toBeDefined();
  button.click();
  await nextTick();
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `missing ${label} button`).toBeDefined();
  return button!;
}

function dispatchPointer(target: HTMLElement, clientX: number, clientY: number): void {
  const event = new MouseEvent("pointerdown", { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function configurationEntry(
  code: string,
  value: string,
  kind: ProjectConfigurationEntry["kind"],
): ProjectConfigurationEntry {
  return {
    code,
    japanese: code,
    english: code,
    value,
    kind,
    allowed: [],
    fixed: false,
    applicability: 12,
    default_value: value,
    effective_value: value,
    application: "hot",
  };
}
