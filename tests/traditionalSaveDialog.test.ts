import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import TraditionalSaveDialog from "@/components/TraditionalSaveDialog.vue";

describe("traditional save dialog", () => {
  it("offers only occupied slots for export", async () => {
    const wrapper = mount(TraditionalSaveDialog, {
      props: {
        open: true,
        mode: "export",
        slots: [
          { slot: 0, occupied: false },
          { slot: 1, occupied: true },
        ],
        importName: "",
        busy: false,
        error: "",
        overwriteSlot: null,
      },
      attachTo: document.body,
    });

    expect(document.querySelectorAll("option")).toHaveLength(1);
    expect(document.querySelector("option")?.textContent).toContain("槽位 01（已有存档）");
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(wrapper.emitted("confirm")?.[0]).toEqual([1]);

    wrapper.unmount();
  });

  it("exposes explicit overwrite confirmation", async () => {
    const wrapper = mount(TraditionalSaveDialog, {
      props: {
        open: true,
        mode: "import",
        slots: [{ slot: 0, occupied: true }],
        importName: "incoming.sav",
        busy: false,
        error: "",
        overwriteSlot: 0,
      },
      attachTo: document.body,
    });

    expect(document.body.textContent).toContain("确认要用所选文件覆盖这个存档吗？");
    const overwrite = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "确认覆盖",
    );
    overwrite?.click();
    expect(wrapper.emitted("confirmOverwrite")).toHaveLength(1);

    wrapper.unmount();
  });
});
