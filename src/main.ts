import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./styles.css";

if (import.meta.env.VITE_RUSTYERA_TAURI_TEST === "1") await import("@wdio/tauri-plugin");

const pinia = createPinia();
if (import.meta.env.VITE_RUSTYERA_TEST === "1" && import.meta.env.VITE_RUSTYERA_TEST_STATE) {
  const [{ invoke }, { useRuntimeStore }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@/stores/runtime"),
  ]);
  const bytes = await invoke<number[]>("read_import", {
    path: import.meta.env.VITE_RUSTYERA_TEST_STATE,
  });
  useRuntimeStore(pinia).configureTestRun({
    start: { type: "vm_snapshot", bytes: new Uint8Array(bytes) },
  });
}
createApp(App).use(pinia).mount("#app");

if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
  void import("@/testing/control").then(({ installWebTestControl }) =>
    installWebTestControl(pinia),
  );
}
