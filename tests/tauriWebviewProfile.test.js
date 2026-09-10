// @vitest-environment node
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { isolatedWebviewEnvironment } from "../scripts/tauri-webview-profile.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("isolates successive Windows sessions without touching an inherited user profile", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tauri-profile-"));
  roots.push(root);
  const inherited = { WEBVIEW2_USER_DATA_FOLDER: "existing-user-profile", OTHER: "retained" };
  const first = await isolatedWebviewEnvironment(root, inherited, "win32");
  const second = await isolatedWebviewEnvironment(root, inherited, "win32");
  expect(first.OTHER).toBe("retained");
  expect(inherited.WEBVIEW2_USER_DATA_FOLDER).toBe("existing-user-profile");
  expect(first.WEBVIEW2_USER_DATA_FOLDER).not.toBe(second.WEBVIEW2_USER_DATA_FOLDER);
  for (const folder of [first.WEBVIEW2_USER_DATA_FOLDER, second.WEBVIEW2_USER_DATA_FOLDER]) {
    expect(path.dirname(folder)).toBe(path.join(root, ".rustyera/test-runs/webview2"));
    expect((await stat(folder)).isDirectory()).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  }
});

it("leaves other platforms' environment intact without creating Windows profile data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tauri-profile-"));
  roots.push(root);
  const environment = { OTHER: "retained" };
  expect(await isolatedWebviewEnvironment(root, environment, "darwin")).toEqual(environment);
  expect(await readdir(root)).toEqual([]);
});
