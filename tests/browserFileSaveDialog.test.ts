import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import BrowserFileSaveDialog from "@/components/BrowserFileSaveDialog.vue";
import DraggableDialog from "@/components/DraggableDialog.vue";
import { BROWSER_FILE_SAVE_EVENT } from "@/platform/browserDownload";

function enqueue(file: File, release?: () => void): void {
  window.dispatchEvent(new CustomEvent(BROWSER_FILE_SAVE_EVENT, { detail: { file, release } }));
}

function button(label: string): HTMLButtonElement {
  return [...document.body.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  )!;
}

describe("BrowserFileSaveDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("calls share synchronously from the confirmation click and removes a successful file", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    const file = new File([Uint8Array.of(1, 2, 3)], "runtime.snapshot");
    const release = vi.fn();
    enqueue(file, release);
    await nextTick();

    button("打开系统分享菜单").click();
    expect(share).toHaveBeenCalledWith({ files: [file], title: file.name });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain(file.name));
    expect(release).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("keeps concurrent exports in FIFO order while a share is busy", async () => {
    let finishFirst!: () => void;
    const firstShare = new Promise<void>((resolve) => (finishFirst = resolve));
    const share = vi.fn().mockReturnValueOnce(firstShare).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    const first = new File([], "first.snapshot");
    const second = new File([], "second.reraproj");
    const third = new File([], "third.tar.zst");
    enqueue(first);
    enqueue(second);
    await nextTick();

    button("打开系统分享菜单").click();
    enqueue(third);
    await nextTick();
    expect(button("正在打开").disabled).toBe(true);
    expect(button("取消").disabled).toBe(true);
    document
      .querySelector<HTMLElement>("[aria-label='保存导出文件']")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.body.textContent).toContain(first.name);
    button("正在打开").click();
    expect(share).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.waitFor(() => expect(document.body.textContent).toContain(second.name));
    button("取消").click();
    await nextTick();
    expect(document.body.textContent).toContain(third.name);
    button("打开系统分享菜单").click();
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    wrapper.unmount();
  });

  it("retains a cancelled share and re-enables retry", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("navigator", { share });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    const file = new File([], "runtime.snapshot");
    const release = vi.fn();
    enqueue(file, release);
    await nextTick();

    button("打开系统分享菜单").click();
    let retry: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      retry = document.querySelector<HTMLButtonElement>(
        "[aria-label='保存导出文件'] button.primary",
      );
      const cancel = document.querySelector<HTMLButtonElement>(
        "[aria-label='保存导出文件'] .dialog-actions button:not(.primary)",
      );
      expect(retry?.textContent?.trim()).toBe("打开系统分享菜单");
      expect(retry?.disabled).toBe(false);
      expect(cancel?.textContent?.trim()).toBe("取消");
      expect(cancel?.disabled).toBe(false);
    });
    expect(document.body.textContent).toContain(file.name);
    expect(document.querySelector("[role='alert']")).toBeNull();

    expect(share).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(file.name);
    expect(release).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains a failed share and exposes its error", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share unavailable"));
    vi.stubGlobal("navigator", { share });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    const file = new File([], "runtime.snapshot");
    enqueue(file);
    await nextTick();

    button("打开系统分享菜单").click();

    await vi.waitFor(() =>
      expect(document.querySelector("[role='alert']")?.textContent).toContain("share unavailable"),
    );
    expect(document.body.textContent).toContain(file.name);
    expect(share).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("keeps an active backing file through unmount until sharing settles", async () => {
    let finishShare!: () => void;
    const share = vi.fn(() => new Promise<void>((resolve) => (finishShare = resolve)));
    vi.stubGlobal("navigator", { share });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    const activeRelease = vi.fn();
    const queuedRelease = vi.fn();
    enqueue(new File([], "active.reraproj"), activeRelease);
    enqueue(new File([], "queued.tar.zst"), queuedRelease);
    await nextTick();

    button("打开系统分享菜单").click();
    wrapper.unmount();

    expect(activeRelease).not.toHaveBeenCalled();
    expect(queuedRelease).toHaveBeenCalledOnce();
    finishShare();
    await vi.waitFor(() => expect(activeRelease).toHaveBeenCalledOnce());
  });

  it("ignores malformed global save events", async () => {
    vi.stubGlobal("navigator", { share: vi.fn() });
    const wrapper = mount(BrowserFileSaveDialog, { attachTo: document.body });
    window.dispatchEvent(new CustomEvent(BROWSER_FILE_SAVE_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(BROWSER_FILE_SAVE_EVENT));
    window.dispatchEvent(
      new CustomEvent(BROWSER_FILE_SAVE_EVENT, {
        detail: { file: new File([], "invalid.snapshot"), release: "invalid" },
      }),
    );
    await nextTick();
    expect(document.querySelector("[aria-label='保存导出文件']")).toBeNull();
    wrapper.unmount();
  });

  it("stacks above an existing modal and restores focus without closing the lower dialog", async () => {
    vi.stubGlobal("navigator", { share: vi.fn() });
    const Host = defineComponent({
      components: { BrowserFileSaveDialog, DraggableDialog },
      template: `
        <DraggableDialog :open="true" title="日志">
          <button id="export-trigger" type="button">导出</button>
        </DraggableDialog>
        <BrowserFileSaveDialog />
      `,
    });
    const wrapper = mount(Host, { attachTo: document.body });
    await nextTick();
    const trigger = document.querySelector<HTMLButtonElement>("#export-trigger")!;
    trigger.focus();
    enqueue(new File([], "runtime.snapshot"));
    await nextTick();

    const dialogs = [...document.body.querySelectorAll<HTMLElement>("[role='dialog']")];
    expect(dialogs.map((dialog) => dialog.getAttribute("aria-label"))).toEqual([
      "日志",
      "保存导出文件",
    ]);
    await vi.waitFor(() => expect(document.activeElement).toBe(dialogs[1]));
    dialogs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(document.querySelector("[aria-label='保存导出文件']")).toBeNull();
    expect(document.querySelector("[aria-label='日志']")).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    wrapper.unmount();
  });
});
