import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AboutDialog from "@/components/AboutDialog.vue";

describe("AboutDialog", () => {
  it("shows authorship, frontend/core versions, and license", async () => {
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true },
    });

    expect(document.body.textContent).toContain("PrunusSerrulata");
    expect(document.body.textContent).toContain("前端版本");
    expect(document.body.textContent).toContain("0.2.1-wasm");
    expect(document.body.textContent).toContain("core 版本");
    expect(document.body.textContent).toContain("0.2.0 (bc381494)");
    expect(document.body.textContent).toContain("GPL-3.0-only");

    document.body.querySelector<HTMLButtonElement>("button.primary")!.click();
    await Promise.resolve();
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows the Tauri release suffix in the desktop host", () => {
    window.__TAURI_INTERNALS__ = {};
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true },
    });

    expect(document.body.textContent).toContain("0.2.1-tauri");

    wrapper.unmount();
    delete window.__TAURI_INTERNALS__;
  });
});
