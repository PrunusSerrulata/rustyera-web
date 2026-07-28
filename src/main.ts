import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./styles.css";

const pinia = createPinia();
createApp(App).use(pinia).mount("#app");

if (import.meta.env.VITE_RUSTYERA_TEST === "1") {
  void import("@/testing/control").then(({ installWebTestControl }) =>
    installWebTestControl(pinia),
  );
}
