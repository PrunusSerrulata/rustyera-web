import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CornerNotifications from "@/components/CornerNotifications.vue";
import type { LogNotificationState } from "@/core/log";

const initialNotifications: LogNotificationState[] = [
  { id: 1, level: "warning", message: "first" },
  { id: 2, level: "error", message: "second" },
  { id: 3, level: "warning", message: "third" },
];

const cleanups: Array<() => void> = [];

describe("corner notification stack", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders notifications in creation order without overlap-oriented positioning", () => {
    const wrapper = trackedMount(initialNotifications);

    expect(wrapper.findAll(".log-notification").map((item) => item.text())).toEqual([
      "警告first ×",
      "错误second ×",
      "警告third ×",
    ]);
    expect(wrapper.get(".corner-notifications").attributes("style")).toContain("gap: 8px");
  });

  it("keeps deleting the oldest entries until the entire remaining stack fits", async () => {
    let notificationHeight = 30;
    mockRects(() => notificationHeight);
    vi.stubGlobal("innerHeight", 152);
    const { wrapper, items, dismissed } = managedMount(initialNotifications, (id) => {
      if (id === 1) notificationHeight = 60;
    });

    await flushFits();

    expect(dismissed).toEqual([1, 2]);
    expect(items.value.map((item) => item.id)).toEqual([3]);
    expect(totalStackHeight(wrapper, 8)).toBeLessThan(100);
  });

  it("does not render the removed diagnosis corner notification", () => {
    const wrapper = trackedMount(initialNotifications);

    expect(wrapper.find(".diagnosis-notification").exists()).toBe(false);
  });

  it("evicts the oldest entry when the stack exactly equals the available height", async () => {
    mockRects(() => 40);
    vi.stubGlobal("innerHeight", 140);
    const twoNotifications = initialNotifications.slice(0, 2);
    const { items, dismissed } = managedMount(twoNotifications);

    await flushFits();

    expect(dismissed).toEqual([1]);
    expect(items.value.map((item) => item.id)).toEqual([2]);
  });

  it("reflows the lower entries immediately after manual dismissal", async () => {
    mockRects(() => 40);
    vi.stubGlobal("innerHeight", 300);
    const { wrapper, items } = managedMount(initialNotifications);
    await flushFits();

    await wrapper.get("button[aria-label='关闭警告']").trigger("click");
    await nextTick();

    expect(items.value.map((item) => item.id)).toEqual([2, 3]);
    expect(wrapper.findAll(".log-notification").map((item) => item.text())).toEqual([
      "错误second ×",
      "警告third ×",
    ]);
  });

  it("preserves independent deadlines for notifications created at different times", async () => {
    vi.useFakeTimers();
    mockRects(() => 40);
    vi.stubGlobal("innerHeight", 300);
    const { items } = managedMount(initialNotifications.slice(0, 1));
    await flushFits();

    await vi.advanceTimersByTimeAsync(4_000);
    items.value.push({ id: 2, level: "error", message: "second" });
    await flushFits();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(items.value.map((item) => item.id)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(items.value.map((item) => item.id)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(items.value).toEqual([]);
  });

  it("reacts to child size changes even when the outer container size is unchanged", async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(element: Element): void {
          observed.push(element);
        }
        disconnect(): void {}
      },
    );
    let notificationHeight = 40;
    mockRects(() => notificationHeight);
    vi.stubGlobal("innerHeight", 152);
    const { items } = managedMount(initialNotifications.slice(0, 1));
    await flushFits();

    expect(observed.some((element) => element.classList.contains("log-notification"))).toBe(true);
    expect(observed.some((element) => element.classList.contains("corner-notifications"))).toBe(
      false,
    );

    notificationHeight = 120;
    resizeCallback?.([], {} as ResizeObserver);
    await flushFits();

    expect(items.value).toEqual([]);
  });
});

function trackedMount(notifications: LogNotificationState[]) {
  const wrapper = mount(CornerNotifications, { props: { notifications } });
  cleanups.push(() => wrapper.unmount());
  return wrapper;
}

function managedMount(notifications: LogNotificationState[], afterDismiss?: (id: number) => void) {
  const items = ref(notifications.map((notification) => ({ ...notification })));
  const dismissed: number[] = [];
  const wrapper = mount(
    defineComponent({
      components: { CornerNotifications },
      setup() {
        const dismiss = (id: number) => {
          dismissed.push(id);
          const index = items.value.findIndex((item) => item.id === id);
          if (index >= 0) items.value.splice(index, 1);
          afterDismiss?.(id);
        };
        return { dismiss, items };
      },
      template: '<CornerNotifications :notifications="items" @dismiss="dismiss" />',
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { dismissed, items, wrapper };
}

function mockRects(notificationHeight: () => number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.classList.contains("log-notification") ? notificationHeight() : 0;
    const top = this.classList.contains("corner-notifications") ? 42 : 0;
    return { top, height } as DOMRect;
  });
}

async function flushFits(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await nextTick();
}

function totalStackHeight(wrapper: ReturnType<typeof mount>, gap: number): number {
  const items = wrapper.findAll<HTMLElement>(".log-notification");
  return (
    items.reduce((total, item) => total + item.element.getBoundingClientRect().height, 0) +
    Math.max(0, items.length - 1) * gap
  );
}
