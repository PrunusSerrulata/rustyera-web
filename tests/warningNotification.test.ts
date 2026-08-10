import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WarningNotification from "@/components/WarningNotification.vue";

describe("warning notification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows an accessible warning with a countdown and closes after eight seconds", async () => {
    const wrapper = mount(WarningNotification, {
      props: { id: 7, message: "脚本可能存在兼容性问题" },
    });

    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.text()).toContain("脚本可能存在兼容性问题");
    expect(wrapper.get(".warning-notification-countdown").attributes("style")).toContain(
      "animation-duration: 8000ms",
    );
    expect(wrapper.get("button").attributes("aria-label")).toBe("关闭警告");

    await vi.advanceTimersByTimeAsync(7_999);
    expect(wrapper.emitted("close")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(wrapper.emitted("close")).toEqual([[7]]);
  });

  it("emits close only once when dismissed manually", async () => {
    const wrapper = mount(WarningNotification, {
      props: { id: 8, message: "手动关闭" },
    });

    await wrapper.get("button[aria-label='关闭警告']").trigger("click");
    await vi.advanceTimersByTimeAsync(8_000);

    expect(wrapper.emitted("close")).toEqual([[8]]);
  });

  it("cleans up its timer when unmounted", async () => {
    const wrapper = mount(WarningNotification, {
      props: { id: 9, message: "即将卸载" },
    });

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(wrapper.emitted("close")).toBeUndefined();
  });
});
