import { readFileSync } from "node:fs";

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import AboutDialog from "@/components/AboutDialog.vue";

describe("AboutDialog", () => {
  it("shows authorship, frontend/core versions, and license", async () => {
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true, coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION },
    });

    expect(document.body.textContent).toContain("PrunusSerrulata");
    expect(document.body.textContent).toContain("前端版本");
    expect(document.body.textContent).toContain("0.6.0-wasm");
    expect(document.body.textContent).toContain("core 版本");
    const coreRevision = readFileSync("rustyera-core.rev", "utf8").trim().slice(0, 8);
    expect(document.body.textContent).toContain(`0.6.0 (${coreRevision})`);
    expect(document.body.textContent).toContain("GPL-3.0-only");
    expect(document.body.textContent).toContain("仅适用于 RustyEra 相关组件");
    expect(
      document.body.querySelector<HTMLAnchorElement>(
        'a[href="https://github.com/PrunusSerrulata/rustyera-core"]',
      )?.textContent,
    ).toBe("rustyera-core");
    expect(
      document.body.querySelector<HTMLAnchorElement>(
        'a[href="https://github.com/PrunusSerrulata/rustyera-web"]',
      )?.textContent,
    ).toBe("rustyera-web");
    expect(document.body.textContent).not.toContain("当前游戏");

    document.body.querySelector<HTMLButtonElement>("button.primary")!.click();
    await Promise.resolve();
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows the Tauri release suffix in the desktop host", () => {
    window.__TAURI_INTERNALS__ = {};
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true, coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION },
    });

    expect(document.body.textContent).toContain("0.6.0-tauri");

    wrapper.unmount();
    delete window.__TAURI_INTERNALS__;
  });

  it("shows only defined fields for the loaded game", () => {
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: {
        open: true,
        coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION,
        gameInformation: {
          title: "Demo",
          version: "1.001",
          information: "Notes",
        },
      },
    });

    expect(document.body.textContent).toContain("当前游戏");
    expect(document.body.textContent).toContain("游戏名称Demo");
    expect(document.body.textContent).toContain("游戏版本1.001");
    expect(document.body.textContent).toContain("备注Notes");
    expect(document.body.textContent).not.toContain("游戏作者");
    expect(document.body.textContent).not.toContain("游戏开发时间");

    wrapper.unmount();
  });
});
