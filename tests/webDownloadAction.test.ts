import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runAction } from "../scripts/web-test-lib.mjs";

it("arms the native download before clicking and never overwrites an artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rustyera-download-"));
  const source = path.join(directory, "native-download");
  const destination = path.join(directory, "project.reraproj");
  await writeFile(source, new Uint8Array([0, 255, 42]));
  const events: string[] = [];
  const download = {
    suggestedFilename: () => "game.reraproj",
    failure: async () => null,
    path: async () => source,
  };
  const page = {
    waitForEvent: vi.fn(() => {
      events.push("armed");
      return Promise.resolve(download);
    }),
    locator: vi.fn(() => ({
      click: async () => {
        events.push("clicked");
      },
    })),
  };
  const action = {
    type: "save_download" as const,
    path: destination,
    name_suffix: ".reraproj",
    selector: "#export",
  };
  try {
    await runAction(page as never, action);
    expect(events).toEqual(["armed", "clicked"]);
    expect(page.waitForEvent).toHaveBeenCalledWith("download", { timeout: 0 });
    expect([...(await readFile(destination))]).toEqual([0, 255, 42]);
    await expect(runAction(page as never, action)).rejects.toThrow("already exists");
    expect(events).toEqual(["armed", "clicked"]);
    expect([...(await readFile(destination))]).toEqual([0, 255, 42]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { name: "wrong.sav", failure: null, bytes: [1] },
  { name: "game.reraproj", failure: "cancelled", bytes: [1] },
  { name: "game.reraproj", failure: null, bytes: [] },
])("rejects a mismatched, failed, or empty native download", async (download) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rustyera-download-invalid-"));
  const source = path.join(directory, "native-download");
  const destination = path.join(directory, "project.reraproj");
  await writeFile(source, new Uint8Array(download.bytes));
  const page = {
    waitForEvent: vi.fn().mockResolvedValue({
      suggestedFilename: () => download.name,
      failure: async () => download.failure,
      path: async () => source,
    }),
    locator: vi.fn(() => ({ click: async () => {} })),
  };
  try {
    await expect(
      runAction(page as never, {
        type: "save_download",
        path: destination,
        name_suffix: ".reraproj",
        selector: "#export",
      }),
    ).rejects.toThrow();
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
