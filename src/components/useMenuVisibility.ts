import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

import { menuVisibleAtHeight, type MenuVisibilityMode } from "@/core/menuVisibility";

export function useMenuVisibility(mode: Readonly<Ref<MenuVisibilityMode>>) {
  const viewportHeight = ref(
    typeof window === "undefined"
      ? Number.POSITIVE_INFINITY
      : window.visualViewport?.height ||
          document.documentElement.clientHeight ||
          window.innerHeight,
  );
  const touchSupported = ref(typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
  const temporarilyVisible = ref(false);
  const baseVisible = computed(() => menuVisibleAtHeight(mode.value, viewportHeight.value));
  const touchToggleVisible = computed(() => touchSupported.value && !baseVisible.value);

  function measureViewport(): void {
    viewportHeight.value =
      window.visualViewport?.height || document.documentElement.clientHeight || window.innerHeight;
  }

  function toggleTouchMenu(): void {
    if (!touchToggleVisible.value) return;
    temporarilyVisible.value = !temporarilyVisible.value;
  }

  watch([mode, viewportHeight], () => {
    temporarilyVisible.value = false;
  });

  onMounted(() => {
    measureViewport();
    window.addEventListener("resize", measureViewport);
    window.visualViewport?.addEventListener("resize", measureViewport);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", measureViewport);
    window.visualViewport?.removeEventListener("resize", measureViewport);
  });

  return {
    baseVisible,
    temporarilyVisible,
    touchToggleVisible,
    toggleTouchMenu,
  };
}
