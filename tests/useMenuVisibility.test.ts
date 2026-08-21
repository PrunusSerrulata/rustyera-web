import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { useMenuVisibility } from "@/components/useMenuVisibility";
import type { MenuVisibilityMode } from "@/core/menuVisibility";

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");

function setViewportHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function setTouchPoints(points: number): void {
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: points });
}

afterEach(() => {
  if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
  if (originalTouchPoints) {
    Object.defineProperty(navigator, "maxTouchPoints", originalTouchPoints);
  }
});

describe("useMenuVisibility", () => {
  it("uses initial viewport and touch values before mount effects run", () => {
    setViewportHeight(479);
    setTouchPoints(1);
    const mode = ref<MenuVisibilityMode>("AUTO");
    const wrapper = mount(
      defineComponent({
        setup() {
          return useMenuVisibility(mode);
        },
        template:
          '<div :data-base="baseVisible" :data-toggle="touchToggleVisible" :data-temporary="temporarilyVisible" />',
      }),
    );

    expect(wrapper.attributes()).toMatchObject({
      "data-base": "false",
      "data-toggle": "true",
      "data-temporary": "false",
    });
    wrapper.unmount();
  });

  it("clears temporary visibility on height or mode changes and removes resize listeners", async () => {
    setViewportHeight(479);
    setTouchPoints(1);
    const mode = ref<MenuVisibilityMode>("AUTO");
    const wrapper = mount(
      defineComponent({
        setup() {
          return { mode, ...useMenuVisibility(mode) };
        },
        template:
          '<button :data-base="baseVisible" :data-temporary="temporarilyVisible" @click="toggleTouchMenu" />',
      }),
    );

    await wrapper.trigger("click");
    expect(wrapper.attributes("data-temporary")).toBe("true");

    setViewportHeight(478);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.attributes("data-temporary")).toBe("false");

    await wrapper.trigger("click");
    mode.value = "HIDE";
    await nextTick();
    expect(wrapper.attributes("data-temporary")).toBe("false");

    mode.value = "AUTO";
    setViewportHeight(600);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.attributes("data-base")).toBe("true");

    wrapper.unmount();
    setViewportHeight(400);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.attributes("data-base")).toBe("true");
  });
});
