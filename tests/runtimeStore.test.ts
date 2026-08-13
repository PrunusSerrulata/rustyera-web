import { vi } from "vitest";

vi.mock("@/platform", async () => {
  const { bridge } = await import("./runtimeStoreBridgeMock");
  return { platformBridge: () => bridge };
});

import "./runtimeStore-cache-input.cases";
import "./runtimeStore-configuration.cases";
import "./runtimeStore-debug-presentation-reload.cases";
import "./runtimeStore-diagnosis.cases";
import "./runtimeStore-settings-export.cases";
import "./runtimeStore-startup-save.cases";
