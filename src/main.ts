import { createPinia } from "pinia";
import { createApp } from "vue";
import { registerSW } from "virtual:pwa-register";

import App from "./App.vue";
import "./styles.css";
import { ipcBytes } from "@/platform/tauriBridge/ipcBytes";

registerSW({ immediate: true });

if (import.meta.env.VITE_RUSTYERA_TAURI_TEST === "1") await import("@wdio/tauri-plugin");

const pinia = createPinia();
if (import.meta.env.VITE_RUSTYERA_TEST === "1" && import.meta.env.VITE_RUSTYERA_TEST_STATE) {
  const [{ invoke }, { useRuntimeStore }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@/stores/runtime"),
  ]);
  const bytes = ipcBytes(
    await invoke("read_import", {
      path: import.meta.env.VITE_RUSTYERA_TEST_STATE,
    }),
  );
  const stateType =
    import.meta.env.VITE_RUSTYERA_TEST_STATE_TYPE === "traditional_save"
      ? "traditional_save"
      : "vm_snapshot";
  useRuntimeStore(pinia).configureTestRun({
    start: { type: stateType, bytes },
  });
}
createApp(App).use(pinia).mount("#app");

if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
  void import("@/testing/control").then(({ installWebTestControl }) =>
    installWebTestControl(pinia),
  );
}
