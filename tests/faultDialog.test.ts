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
  fault: { message: "boom" } as { message: string } | null,
  faultActionBusy: false,
  canExportDiagnosis: true,
  gameInteractionsBlocked: false,
  ...mocks,
});

vi.mock("@/stores/runtime", () => ({ useRuntimeStore: () => store }));

import FaultDialog from "@/components/FaultDialog.vue";

describe("FaultDialog", () => {
  beforeEach(() => {
    store.fault = { message: "boom" };
    store.faultActionBusy = false;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("dispatches every recovery action and remains dismissible", async () => {
    const wrapper = mount(FaultDialog, { attachTo: document.body });
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")];

    await clickNamed(buttons, "导出诊断信息");
    await clickNamed(buttons, "返回主菜单");
    await clickNamed(buttons, "重启并重新编译");
    await clickNamed(buttons, "退出");
    await clickNamed(buttons, "关闭", true);

    expect(mocks.exportDiagnosis).toHaveBeenCalledOnce();
    expect(mocks.recoverFromFault).toHaveBeenNthCalledWith(1, "title");
    expect(mocks.recoverFromFault).toHaveBeenNthCalledWith(2, "reload");
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.dismissFault).toHaveBeenCalledOnce();
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
