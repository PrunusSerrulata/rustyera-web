import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  bridgeKind: "browser",
  presentation: { settings: {}, inputWait: null },
  gameTextStyle: { fontFamily: "sans-serif", fontSize: "16px" },
  status: "正在编译项目…",
  projectLoading: true,
  projectLoadProgressLabel: "正在编译脚本函数：64/100（64%）",
  projectLoadProgressValue: 64,
  projectOpen: true,
  canOpenProject: false,
  runtimeReady: false,
  gameInteractionsBlocked: false,
  debugEnabled: true,
  singleStepEnabled: true,
  canStepDebug: true,
  canExportDiagnosis: false,
  canManageTraditionalSaves: false,
  diagnosisNotification: "",
  projectFileExporting: false,
  projectFileExportProgressLabel: "",
  projectFileExportProgressValue: undefined,
  prompt: "",
  canInteract: false,
  promptPlaceholder: "等待 Runtime…",
  inputUndo: null,
  preferencesOpen: false,
  preferences: {},
  configurationEntries: [] as unknown[],
  configurationReadOnly: false,
  useMenu: true,
  gameLineHeightPx: 13,
  systemFonts: [],
  availableFontFamilies: [],
  fontAccessStatus: "idle",
  fontAccessError: "",
  openProjectConfirmationOpen: false,
  gameProgressLossConfirmation: null as "restart" | "title" | null,
  projectReloadDialogMode: null as "folder" | "script" | null,
  projectReloadTargetOptions: [] as string[],
  projectReloadDialogBusy: false,
  projectReloadDialogError: "",
  logsOpen: false,
  logs: [],
  initialize: vi.fn(),
  openProject: vi.fn(),
  openProjectFile: vi.fn(),
  restart: vi.fn(),
  returnToTitle: vi.fn(),
  requestRestart: vi.fn(),
  requestReturnToTitle: vi.fn(),
  reloadProject: vi.fn(),
  openProjectReloadDialog: vi.fn(),
  closeProjectReloadDialog: vi.fn(),
  confirmProjectReload: vi.fn(),
  exportSnapshot: vi.fn(),
  exportProjectFile: vi.fn(),
  cancelProjectFileExport: vi.fn(),
  restoreSnapshot: vi.fn(),
  openTraditionalSaveDialog: vi.fn(),
  closeTraditionalSaveDialog: vi.fn(),
  pickTraditionalSaveImport: vi.fn(),
  confirmTraditionalSaveTransfer: vi.fn(),
  cancelTraditionalSaveOverwrite: vi.fn(),
  confirmTraditionalSaveOverwrite: vi.fn(),
  traditionalSaveDialogMode: null,
  traditionalSaveSlots: [],
  traditionalSaveImportName: "",
  traditionalSaveTransferBusy: false,
  traditionalSaveTransferError: "",
  traditionalSaveOverwriteSlot: null,
  shutdown: vi.fn(),
  enableDebug: vi.fn(),
  openDebugDialog: vi.fn(),
  toggleSingleStep: vi.fn(),
  stepDebug: vi.fn(),
  exportDiagnosis: vi.fn(),
  submitText: vi.fn(),
  undo: vi.fn(),
  preview: vi.fn(),
  savePreferences: vi.fn(),
  openPreferencesFromUser: vi.fn(),
  requestSystemFonts: vi.fn(),
  cancelOpenProject: vi.fn(),
  confirmOpenProject: vi.fn(),
  cancelGameProgressLossAction: vi.fn(),
  confirmGameProgressLossAction: vi.fn(),
}));

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import App from "@/App.vue";

function mountApp() {
  return shallowMount(App, { global: { stubs: { AppMenuBar: false } } });
}

const controlledLabels = [
  "重新开始",
  "返回标题",
  "重新加载全部脚本",
  "重新加载文件夹…",
  "重新加载单个脚本…",
  "导出全量项目文件…",
  "导出 VM 快照…",
  "恢复 VM 快照…",
  "导出存档…",
  "导入存档…",
  "禁用调试",
  "控制台…",
  "变量查看器…",
  "Fibers / 调用栈…",
  "关闭单步运行",
  "单步执行 (F10)",
  "导出诊断信息…",
];

async function menuStates(wrapper: VueWrapper): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  for (const label of ["文件", "调试", "帮助"]) {
    const button = wrapper.findAll("nav > .menu > button").find((item) => item.text() === label);
    await button!.trigger("click");
    for (const item of wrapper.findAll(".menu-popup button")) {
      states.set(item.text(), item.attributes("disabled") !== undefined);
    }
  }
  return states;
}

describe("application menus", () => {
  afterEach(() => {
    vi.clearAllMocks();
    store.runtimeReady = false;
    store.canExportDiagnosis = false;
    store.canManageTraditionalSaves = false;
    store.configurationEntries = [];
  });

  it("requests confirmation for progress-losing game actions", async () => {
    store.runtimeReady = true;
    const wrapper = mountApp();

    await wrapper.get("nav > .menu > button").trigger("click");
    const restart = wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "重新开始");
    await restart!.trigger("click");
    expect(store.requestRestart).toHaveBeenCalledOnce();
    expect(store.restart).not.toHaveBeenCalled();

    await wrapper.get("nav > .menu > button").trigger("click");
    const title = wrapper.findAll(".menu-popup button").find((item) => item.text() === "返回标题");
    await title!.trigger("click");
    expect(store.requestReturnToTitle).toHaveBeenCalledOnce();
    expect(store.returnToTitle).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("routes each script reload menu item to its distinct scope", async () => {
    store.runtimeReady = true;
    const wrapper = mountApp();

    await wrapper.get("nav > .menu > button").trigger("click");
    await wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "重新加载全部脚本")!
      .trigger("click");
    expect(store.reloadProject).toHaveBeenCalledOnce();

    await wrapper.get("nav > .menu > button").trigger("click");
    await wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "重新加载文件夹…")!
      .trigger("click");
    expect(store.openProjectReloadDialog).toHaveBeenCalledWith("folder");

    await wrapper.get("nav > .menu > button").trigger("click");
    await wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "重新加载单个脚本…")!
      .trigger("click");
    expect(store.openProjectReloadDialog).toHaveBeenCalledWith("script");

    wrapper.unmount();
  });

  it("disables project and debug actions until the game is running", async () => {
    const loading = mountApp();
    let states = await menuStates(loading);
    for (const label of controlledLabels) {
      expect(states.get(label), label).toBe(true);
    }
    expect(states.get("日志…")).toBe(false);
    loading.unmount();

    store.runtimeReady = true;
    store.canExportDiagnosis = true;
    store.canManageTraditionalSaves = true;
    const running = mountApp();
    states = await menuStates(running);
    for (const label of controlledLabels) {
      expect(states.get(label), label).toBe(false);
    }
    running.unmount();
  });

  it("shows portable save transfer actions only in the WASM host", async () => {
    store.bridgeKind = "tauri";
    const wrapper = mountApp();
    const states = await menuStates(wrapper);

    expect(states.has("导出存档…")).toBe(false);
    expect(states.has("导入存档…")).toBe(false);

    wrapper.unmount();
    store.bridgeKind = "browser";
  });

  it("enables settings only when a project configuration is available", async () => {
    let wrapper = mountApp();
    let states = await menuStates(wrapper);
    expect(states.get("设置…")).toBe(true);
    wrapper.unmount();

    store.configurationEntries = [{}];
    wrapper = mountApp();
    states = await menuStates(wrapper);
    expect(states.get("设置…")).toBe(false);
    wrapper.unmount();
  });

  it("opens settings through the store font-access flow", async () => {
    store.configurationEntries = [{}];
    const wrapper = mountApp();

    await wrapper.get("nav > .menu > button").trigger("click");
    const settings = wrapper.findAll(".menu-popup button").find((item) => item.text() === "设置…");
    await settings!.trigger("click");

    expect(store.openPreferencesFromUser).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("shows the active internal project workload", () => {
    const wrapper = mountApp();
    const progress = wrapper.get("[aria-label='项目加载进度']");

    expect(wrapper.get(".app-shell").attributes("aria-busy")).toBe("true");
    expect(progress.text()).toBe("正在编译脚本函数：64/100（64%）");
    expect(progress.find("progress").exists()).toBe(true);
    expect(progress.find("progress").attributes("value")).toBe("64");

    wrapper.unmount();
  });

  it("labels the WASM exit action as closing the current tab", async () => {
    const wrapper = mountApp();
    const states = await menuStates(wrapper);

    expect(states.has("关闭当前标签页")).toBe(true);
    expect(states.has("退出")).toBe(false);

    wrapper.unmount();
  });
});
