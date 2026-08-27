import { readFileSync } from "node:fs";

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import AboutDialog from "@/components/AboutDialog.vue";

describe("AboutDialog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("shows authorship, frontend/core versions, and license", async () => {
    vi.stubEnv("VITE_RUSTYERA_FRONTEND_COMMIT", undefined);
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true, coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION },
    });

    expect(document.body.textContent).toContain("PrunusSerrulata");
    expect(document.body.textContent).toContain("前端版本");
    expect(document.body.querySelectorAll(".about-details dd")[1]?.textContent).toBe("0.9.0-wasm");
    expect(document.body.textContent).toContain("core 版本");
    const coreRevision = readFileSync("rustyera-core.rev", "utf8").trim().slice(0, 8);
    expect(document.body.textContent).toContain(`0.8.0 (${coreRevision})`);
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
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubEnv("VITE_RUSTYERA_FRONTEND_COMMIT", "abcd1234567890abcdef1234567890abcdef123456");
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true, coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION },
    });

    expect(document.body.querySelectorAll(".about-details dd")[1]?.textContent).toBe("0.9.0-tauri");

    wrapper.unmount();
  });

  it.each([
    ["abcd1234567890abcdef1234567890abcdef123456", "0.9.0-wasm (abcd1234)"],
    ["", "0.9.0-wasm"],
  ])("shows the Pages commit when provided (%s)", (commit, expectedVersion) => {
    vi.stubEnv("VITE_RUSTYERA_FRONTEND_COMMIT", commit);
    const wrapper = mount(AboutDialog, {
      attachTo: document.body,
      props: { open: true, coreVersion: import.meta.env.VITE_RUSTYERA_CORE_VERSION },
    });

    expect(document.body.querySelectorAll(".about-details dd")[1]?.textContent).toBe(
      expectedVersion,
    );

    wrapper.unmount();
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
