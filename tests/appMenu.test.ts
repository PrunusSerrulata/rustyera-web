import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");

function setViewportHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function setTouchPoints(points: number): void {
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: points });
}

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
  fault: null,
  debugEnabled: true,
  singleStepEnabled: true,
  canStepDebug: true,
  canExportDiagnosis: false,
  canExportProjectFile: false,
  fullProjectExportSupported: true,
  canManageTraditionalSaves: false,
  diagnosisExporting: false,
  diagnosisProgress: undefined,
  diagnosisProgressLabel: "正在准备诊断信息…",
  diagnosisProgressValue: undefined as number | undefined,
  diagnosisResult: "",
  projectFileExporting: false,
  projectFileExportProgressLabel: "",
  projectFileExportProgressValue: undefined,
  prompt: "",
  canInteract: false,
  promptPlaceholder: "等待 Runtime…",
  inputUndo: null,
  preferencesOpen: false,
  projectSettingsOpen: false,
  preferences: {},
  projectPreferences: { settings: {} },
  projectPreferencesWritable: false,
  configurationEntries: [] as unknown[],
  configurationReadOnly: false,
  menuMode: "SHOW" as "SHOW" | "AUTO" | "HIDE",
  directProjectDirectoryAccess: true,
  memoryConstrained: false,
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
  saveProjectSettings: vi.fn(),
  saveClientPreferences: vi.fn(),
  openPreferencesFromUser: vi.fn(),
  openProjectSettingsFromUser: vi.fn(),
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
  afterAll(() => {
    if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
    if (originalTouchPoints)
      Object.defineProperty(navigator, "maxTouchPoints", originalTouchPoints);
  });

  afterEach(() => {
    vi.clearAllMocks();
    store.runtimeReady = false;
    store.canExportDiagnosis = false;
    store.canExportProjectFile = false;
    store.fullProjectExportSupported = true;
    store.canManageTraditionalSaves = false;
    store.configurationEntries = [];
    store.projectOpen = true;
    store.projectLoading = true;
    store.diagnosisExporting = false;
    store.diagnosisProgressValue = undefined;
    store.diagnosisProgressLabel = "正在准备诊断信息…";
    store.menuMode = "SHOW";
    store.directProjectDirectoryAccess = true;
    store.memoryConstrained = false;
    setViewportHeight(768);
    setTouchPoints(0);
  });

  it("shows only applicable browser startup hints", () => {
    store.projectOpen = false;
    store.directProjectDirectoryAccess = false;
    store.memoryConstrained = true;
    const wrapper = mountApp();

    expect(wrapper.text()).not.toContain("以同一套 Vue 界面运行于桌面和浏览器。");
    expect(wrapper.text()).not.toContain("Chromium 可直接读写项目目录");
    expect(wrapper.text()).toContain("该浏览器不支持文件系统访问API，启动性能会受影响");
    expect(wrapper.text()).toContain("低内存优化已启用，启动及快照恢复等会受影响");
    expect(wrapper.findAll(".welcome .hint")).toHaveLength(2);
    wrapper.unmount();

    store.directProjectDirectoryAccess = true;
    store.memoryConstrained = false;
    const chromium = mountApp();
    expect(chromium.find(".welcome .hint").exists()).toBe(false);
    chromium.unmount();
  });

  it("temporarily toggles an automatic hidden menu on touch devices", async () => {
    store.menuMode = "AUTO";
    setViewportHeight(479);
    setTouchPoints(1);
    const wrapper = mountApp();

    expect(wrapper.classes()).toContain("menu-overlay");
    const toggle = wrapper.get(".menu-touch-toggle");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");
    expect(wrapper.classes()).toContain("menu-overlay-open");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    await toggle.trigger("click");
    expect(wrapper.classes()).not.toContain("menu-overlay-open");
    expect(store.menuMode).toBe("AUTO");
    wrapper.unmount();

    setViewportHeight(480);
    const boundary = mountApp();
    expect(boundary.classes()).not.toContain("menu-overlay");
    expect(boundary.find(".menu-touch-toggle").exists()).toBe(false);
    boundary.unmount();
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
    store.canExportProjectFile = true;
    store.canManageTraditionalSaves = true;
    const running = mountApp();
    states = await menuStates(running);
    for (const label of controlledLabels) {
      expect(states.get(label), label).toBe(false);
    }
    running.unmount();
  });

  it("explains and blocks full project export when the active browser project file is unsupported", async () => {
    store.runtimeReady = true;
    store.canExportProjectFile = false;
    store.fullProjectExportSupported = false;
    const wrapper = mountApp();

    await wrapper.get("nav > .menu > button").trigger("click");
    const exportButton = wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "导出全量项目文件…")!;
    expect(exportButton.attributes("disabled")).toBeDefined();
    expect(exportButton.attributes("title")).toBe("浏览器从项目文件启动时暂不支持导出全量项目文件");
    await exportButton.trigger("click");
    expect(store.exportProjectFile).not.toHaveBeenCalled();

    wrapper.unmount();
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
    expect(states.get("项目设置…")).toBe(true);
    wrapper.unmount();

    store.configurationEntries = [{}];
    wrapper = mountApp();
    states = await menuStates(wrapper);
    expect(states.get("项目设置…")).toBe(false);
    wrapper.unmount();
  });

  it("opens global preferences from the welcome page before loading a project", async () => {
    store.projectOpen = false;
    store.projectLoading = false;
    const wrapper = mountApp();

    const preferences = wrapper.get("#welcome-preferences");
    expect(preferences.attributes("disabled")).toBeUndefined();
    await preferences.trigger("click");

    expect(store.openPreferencesFromUser).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("opens settings through the store font-access flow", async () => {
    store.configurationEntries = [{}];
    const wrapper = mountApp();

    await wrapper.get("nav > .menu > button").trigger("click");
    const settings = wrapper
      .findAll(".menu-popup button")
      .find((item) => item.text() === "项目设置…");
    await settings!.trigger("click");

    expect(store.openProjectSettingsFromUser).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("shows menu diagnosis progress above the viewport without a corner popup", () => {
    store.projectLoading = false;
    store.diagnosisExporting = true;
    store.diagnosisProgressValue = 62;
    store.diagnosisProgressLabel = "正在传输全量项目文件（62%）";
    const wrapper = mountApp();

    const progress = wrapper.get<HTMLProgressElement>(".diagnosis-export-progress progress");
    expect(progress.attributes("value")).toBe("62");
    expect(wrapper.get(".diagnosis-export-progress").text()).toContain(
      "正在传输全量项目文件（62%）",
    );
    expect(wrapper.find(".diagnosis-notification").exists()).toBe(false);
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
