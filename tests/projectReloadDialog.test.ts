import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ProjectReloadDialog from "@/components/ProjectReloadDialog.vue";

describe("project reload dialog", () => {
  it("selects one script and submits its project-relative path", async () => {
    const wrapper = mount(ProjectReloadDialog, {
      props: {
        mode: "script",
        targets: ["ERB/commands/first.erb", "ERB/commands/second.erb"],
        busy: false,
        error: "",
      },
      attachTo: document.body,
    });

    const select = document.body.querySelector<HTMLSelectElement>("select")!;
    select.value = "ERB/commands/second.erb";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.body
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted("confirm")).toEqual([["ERB/commands/second.erb"]]);
    wrapper.unmount();
  });

  it("shows an empty-target error without enabling reload", () => {
    const wrapper = mount(ProjectReloadDialog, {
      props: {
        mode: "folder",
        targets: [],
        busy: false,
        error: "当前项目没有可重新加载的脚本文件夹",
      },
      attachTo: document.body,
    });

    expect(document.body.querySelector("[role='alert']")?.textContent).toContain(
      "没有可重新加载的脚本文件夹",
    );
    expect(document.body.querySelector<HTMLButtonElement>("button.primary")?.disabled).toBe(true);
    wrapper.unmount();
  });
});
