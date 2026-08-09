import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import DraggableDialog from "@/components/DraggableDialog.vue";

describe("DraggableDialog", () => {
  it("closes with Escape and reports accessible dialog semantics", async () => {
    const wrapper = mount(DraggableDialog, {
      attachTo: document.body,
      props: { open: true, title: "测试对话框" },
      slots: { default: "内容" },
    });
    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("测试对话框");
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("does not let title-bar dragging steal the close button pointer", async () => {
    const wrapper = mount(DraggableDialog, {
      attachTo: document.body,
      props: { open: true, title: "测试对话框" },
      slots: { default: "内容" },
    });
    const close = document.body.querySelector<HTMLButtonElement>("[aria-label='关闭']")!;

    close.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    close.click();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps every dialog key event away from document gameplay handlers", () => {
    const documentKeydown = vi.fn();
    document.addEventListener("keydown", documentKeydown);
    const wrapper = mount(DraggableDialog, {
      attachTo: document.body,
      props: { open: true, title: "测试对话框" },
      slots: { default: '<input aria-label="对话框输入" />' },
    });
    const input = document.body.querySelector<HTMLInputElement>("[aria-label='对话框输入']")!;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(documentKeydown).not.toHaveBeenCalled();
    document.removeEventListener("keydown", documentKeydown);
    wrapper.unmount();
  });
});
