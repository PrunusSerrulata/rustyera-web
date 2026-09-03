// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import {
  prepareNativeProjectUpload,
  uploadNativeProject,
} from "../scripts/native-project-upload.mjs";

afterEach(() => {
  (
    window as unknown as { __RUSTYERA_COMPAT_PICKER_CLEANUP__?: () => void }
  ).__RUSTYERA_COMPAT_PICKER_CLEANUP__?.();
  document.body.replaceChildren();
});

it("retains the production file input without supplying files or synthetic change events", async () => {
  const nativeClick = HTMLInputElement.prototype.click;
  const browser = { execute: async (callback: () => unknown) => callback() };
  await prepareNativeProjectUpload(browser);
  const input = document.createElement("input");
  input.type = "file";
  document.body.append(input);
  const change = vi.fn();
  input.addEventListener("change", change);
  input.click();
  expect(input.isConnected).toBe(true);
  expect(input.files?.length).toBe(0);
  expect(change).not.toHaveBeenCalled();
  (
    window as unknown as { __RUSTYERA_COMPAT_PICKER_CLEANUP__: () => void }
  ).__RUSTYERA_COMPAT_PICKER_CLEANUP__();
  expect(HTMLInputElement.prototype.click).toBe(nativeClick);
});

it("uses native file send keys without clearing the input", async () => {
  const input = { waitForExist: vi.fn(), addValue: vi.fn() };
  const browser = {
    $: vi.fn().mockResolvedValue(input),
    execute: vi.fn().mockResolvedValue({ type: "file", directory: true, multiple: true }),
  };
  await uploadNativeProject(browser, { project: "/isolated/project" });
  expect(input.addValue).toHaveBeenCalledWith("/isolated/project");
  browser.execute.mockResolvedValue({ type: "text", directory: false });
  input.addValue.mockClear();
  await expect(uploadNativeProject(browser, { project: "/isolated/project" })).rejects.toThrow(
    "unexpected native upload input",
  );
  expect(input.addValue).not.toHaveBeenCalled();
});
