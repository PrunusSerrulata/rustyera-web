import { mount } from "@vue/test-utils";
import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dismissFault: vi.fn(),
  exportDiagnosis: vi.fn(),
  recoverFromFault: vi.fn(),
  shutdown: vi.fn(),
}));

const store = reactive({
  bridgeKind: "browser",
  fault: { message: "boom" } as { message: string } | null,
  faultMessage: "Runtime 故障 [VmFault]：boom",
  faultActionBusy: false,
  canExportDiagnosis: true,
  gameInteractionsBlocked: false,
  diagnosisExporting: false,
  diagnosisProgressValue: undefined as number | undefined,
  diagnosisProgressLabel: "正在准备诊断信息…",
  diagnosisResult: "",
  ...mocks,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import FaultDialog from "@/components/FaultDialog.vue";

describe("FaultDialog", () => {
  beforeEach(() => {
    store.fault = { message: "boom" };
    store.faultMessage = "Runtime 故障 [VmFault]：boom";
    store.faultActionBusy = false;
    store.diagnosisExporting = false;
    store.diagnosisProgressValue = undefined;
    store.diagnosisResult = "";
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("dispatches every recovery action and remains dismissible", async () => {
    const wrapper = mount(FaultDialog, { attachTo: document.body });
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")];

    expect(document.body.querySelector(".fault-message")?.textContent).toBe(
      "Runtime 故障 [VmFault]：boom",
    );
    await clickNamed(buttons, "导出诊断信息");
    await clickNamed(buttons, "返回主菜单");
    await clickNamed(buttons, "重启并重新编译");
    await clickNamed(buttons, "关闭当前标签页");
    await clickNamed(buttons, "关闭", true);

    expect(mocks.exportDiagnosis).toHaveBeenCalledOnce();
    expect(mocks.recoverFromFault).toHaveBeenNthCalledWith(1, "title");
    expect(mocks.recoverFromFault).toHaveBeenNthCalledWith(2, "reload");
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.dismissFault).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("shows real export progress inside the fatal dialog", async () => {
    store.diagnosisExporting = true;
    store.diagnosisProgressValue = 37;
    store.diagnosisProgressLabel = "正在导出 VM 快照（37%）";
    const wrapper = mount(FaultDialog, { attachTo: document.body });
    await Promise.resolve();

    const progress = document.body.querySelector<HTMLProgressElement>(
      ".fault-diagnosis-progress progress",
    );
    expect(progress?.getAttribute("value")).toBe("37");
    expect(document.body.querySelector(".fault-diagnosis-progress")?.textContent).toContain(
      "正在导出 VM 快照（37%）",
    );
    expect(document.body.querySelector(".diagnosis-notification")).toBeNull();
    wrapper.unmount();
  });
});

async function clickNamed(
  buttons: HTMLButtonElement[],
  name: string,
  ariaLabel = false,
): Promise<void> {
  const button = buttons.find((candidate) =>
    ariaLabel
      ? candidate.getAttribute("aria-label") === name
      : candidate.textContent?.includes(name),
  );
  expect(button).toBeDefined();
  button!.click();
  await Promise.resolve();
}
