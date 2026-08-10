import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LogNotification from "@/components/LogNotification.vue";

describe("log notification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["warning", "警告", "关闭警告"],
    ["error", "错误", "关闭错误"],
  ] as const)("renders an accessible %s notification", (level, label, closeLabel) => {
    const wrapper = mount(LogNotification, {
      props: { id: 7, level, message: "运行时消息" },
    });

    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.classes()).toContain(level);
    expect(wrapper.text()).toContain(label);
    expect(wrapper.text()).toContain("运行时消息");
    expect(wrapper.get(".log-notification-countdown").attributes("style")).toContain(
      "animation-duration: 8000ms",
    );
    expect(wrapper.get("button").attributes("aria-label")).toBe(closeLabel);
  });

  it("closes independently after eight seconds", async () => {
    const wrapper = mount(LogNotification, {
      props: { id: 8, level: "warning", message: "自动关闭" },
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(wrapper.emitted("close")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.emitted("close")).toEqual([[8]]);
  });

  it("emits close only once when dismissed manually", async () => {
    const wrapper = mount(LogNotification, {
      props: { id: 9, level: "error", message: "手动关闭" },
    });

    await wrapper.get("button[aria-label='关闭错误']").trigger("click");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(wrapper.emitted("close")).toEqual([[9]]);
  });

  it("cleans up its timer when unmounted", async () => {
    const wrapper = mount(LogNotification, {
      props: { id: 10, level: "warning", message: "即将卸载" },
    });

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(wrapper.emitted("close")).toBeUndefined();
  });
});
