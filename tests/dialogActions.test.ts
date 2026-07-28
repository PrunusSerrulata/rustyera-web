import { mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPreferences } from "@/core/types";

const debugCommand = vi.hoisted(() => vi.fn(async () => {}));
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
  debugCommand,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => debugStore }));

import DebugDialogs from "@/components/DebugDialogs.vue";
import LogDialog from "@/components/LogDialog.vue";
import PreferencesDialog from "@/components/PreferencesDialog.vue";

describe("dialog actions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    debugStore.debugConsoleOpen = true;
    debugStore.variablesOpen = true;
    debugStore.stackOpen = true;
    debugStore.debugStop = {
      stop: { program_generation: 1, pause_epoch: 2 },
      selected_fiber: 7,
    };
  });

  it("resets, saves, and cancels preferences", async () => {
    const wrapper = mount(PreferencesDialog, {
      attachTo: document.body,
      props: {
        open: true,
        value: { ...defaultPreferences(), fontSizeOverridePx: 24 },
        fonts: ["Project Font"],
      },
    });

    await clickButton("恢复默认值");
    await clickButton("保存");
    expect(wrapper.emitted("save")?.at(-1)?.[0]).toEqual(defaultPreferences());

    await clickButton("取消");
    expect(wrapper.emitted("close")).toHaveLength(2);
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
