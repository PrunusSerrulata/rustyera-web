import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./styles.css";

if (import.meta.env.VITE_RUSTYERA_TAURI_TEST === "1") await import("@wdio/tauri-plugin");

const pinia = createPinia();
createApp(App).use(pinia).mount("#app");

if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
  void import("@/testing/control").then(({ installWebTestControl }) =>
    installWebTestControl(pinia),
  );
}
