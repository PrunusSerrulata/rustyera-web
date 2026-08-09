import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
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

  it("restores an explicit stable focus target when its open prop closes", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.id = "return-target";
    document.body.append(returnTarget);
    const wrapper = mount(DraggableDialog, {
      attachTo: document.body,
      props: {
        open: false,
        title: "测试对话框",
        returnFocus: "#return-target",
      },
      slots: { default: "内容" },
    });

    returnTarget.focus();
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(returnTarget);

    wrapper.unmount();
    returnTarget.remove();
  });
});
