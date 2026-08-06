import { ref } from "vue";

import type { FontAccessStatus, FrontendBridge } from "@/core/types";

export function useSystemFontAccess(
  bridge: Pick<FrontendBridge, "listFonts">,
  reportFailure: (message: string) => void,
) {
  const systemFonts = ref<string[]>([]);
  const status = ref<FontAccessStatus>("idle");
  const error = ref("");
  let pendingRequest: Promise<void> | undefined;

  function request(): Promise<void> {
    if (status.value === "ready" || status.value === "unsupported") return Promise.resolve();
    if (pendingRequest) return pendingRequest;

    status.value = "loading";
    error.value = "";
    pendingRequest = bridge
      .listFonts()
      .then((result) => {
        systemFonts.value = result.kind === "ready" ? result.fonts : [];
        status.value = result.kind;
        if (result.kind === "error") {
          error.value = result.message;
          reportFailure(result.message);
        }
      })
      .finally(() => {
        pendingRequest = undefined;
      });
    return pendingRequest;
  }

  return { systemFonts, status, error, request };
}
