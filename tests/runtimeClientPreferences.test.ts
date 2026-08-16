import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { defaultPreferences, defaultProjectPreferences } from "@/core/types";
import { RuntimeClientPreferencesState } from "@/stores/runtimeClientPreferences";

function fixture(withProject = true) {
  const global = ref(defaultPreferences());
  const project = ref(defaultProjectPreferences());
  const open = ref(true);
  const send = vi.fn(async () => 7);
  const savePreferences = vi.fn(async (value) => value);
  const applyHostConfiguration = vi.fn(async () => undefined);
  const applyAudio = vi.fn();
  const finishStatus = vi.fn();
  const state = new RuntimeClientPreferencesState({
    bridge: {
      savePreferences,
      saveProjectPreferences: vi.fn(async (value) => value),
    } as any,
    global,
    project,
    open,
    snapshot: () =>
      withProject
        ? {
            project_revision: 3,
            source_digest: new Uint8Array(32),
            entries: [],
            restart_pending: false,
            generated_source: null,
          }
        : undefined,
    entries: () => [
      {
        code: "UseMouse",
        preference_eligible: true,
        client_effective_value: "YES",
      } as any,
    ],
    effective: () => global.value,
    send,
    updateConfiguration: vi.fn(),
    applyHostConfiguration,
    applyAudio,
    beginStatus: vi.fn(() => 1),
    appendElapsed: vi.fn(),
    finishStatus,
    clearStatus: vi.fn(),
    logError: vi.fn(),
  });
  return {
    state,
    global,
    open,
    send,
    savePreferences,
    applyHostConfiguration,
    applyAudio,
    finishStatus,
  };
}

describe("runtime client preference transactions", () => {
  it("saves and closes global preferences without a loaded project", async () => {
    const { state, global, open, send, savePreferences, finishStatus } = fixture(false);

    await state.save("global", {
      settings: {},
      imageScale: 1.5,
      masterVolume: 0.4,
      trustProjectFileMetadata: true,
    });

    expect(savePreferences).toHaveBeenCalledOnce();
    expect(global.value).toMatchObject({
      imageScale: 1.5,
      masterVolume: 0.4,
      trustProjectFileMetadata: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(open.value).toBe(false);
    expect(finishStatus).toHaveBeenCalledWith(1, "全局偏好已应用");
  });

  it("does not report or close a save before the matching Applied response", async () => {
    const { state, open, applyAudio, finishStatus } = fixture();
    const saving = state.save("global", { settings: { UseMouse: "NO" } });
    await flushMicrotasks();

    expect(open.value).toBe(true);
    expect(finishStatus).not.toHaveBeenCalled();
    expect(await state.handleApplied({ configuration: {} }, 6)).toBe(false);
    expect(open.value).toBe(true);

    expect(await state.handleApplied({ configuration: {} }, 7)).toBe(true);
    await saving;
    expect(applyAudio).toHaveBeenCalledOnce();
    expect(open.value).toBe(false);
    expect(finishStatus).toHaveBeenCalledWith(1, "全局偏好已应用");
  });

  it("rejects matching commands and clears pending work on reset", async () => {
    const first = fixture();
    const rejected = first.state.apply();
    await Promise.resolve();
    await Promise.resolve();
    expect(first.state.reject(7, "denied")).toBe(true);
    await expect(rejected).rejects.toThrow("denied");

    const second = fixture();
    const reset = second.state.apply();
    await Promise.resolve();
    await Promise.resolve();
    second.state.reset();
    await expect(reset).rejects.toThrow("已取消");
    expect(await second.state.handleApplied({ configuration: {} }, 7)).toBe(false);
  });

  it("keeps an interleaved game wait intact while a save awaits Applied", async () => {
    const { state } = fixture();
    const game = ref({ phase: "waiting_input", waitId: 11, revision: 20 });
    const saving = state.save("global", { settings: { UseMouse: "NO" } });
    await flushMicrotasks();

    game.value = { phase: "running", waitId: 12, revision: 21 };
    expect(await state.handleApplied({ configuration: {} }, 6)).toBe(false);
    game.value = { phase: "waiting_input", waitId: 13, revision: 22 };
    expect(await state.handleApplied({ configuration: {} }, 7)).toBe(true);
    await saving;

    expect(game.value).toEqual({ phase: "waiting_input", waitId: 13, revision: 22 });
  });

  it("does not let a pre-reset disk save apply to or unlock a newer game session", async () => {
    let finishFirstSave!: (value: ReturnType<typeof defaultPreferences>) => void;
    let finishSecondSave!: (value: ReturnType<typeof defaultPreferences>) => void;
    const first = fixture();
    first.savePreferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecondSave = resolve;
          }),
      );

    const staleSave = first.state.save("global", { settings: { UseMouse: "NO" } });
    await Promise.resolve();
    first.state.reset();
    const currentSave = first.state.save("global", { settings: { UseMouse: "YES" } });
    finishFirstSave(defaultPreferences());
    await staleSave;
    await Promise.resolve();

    expect(first.state.busy.value).toBe(true);
    expect(first.send).not.toHaveBeenCalled();
    expect(first.open.value).toBe(true);
    expect(first.finishStatus).not.toHaveBeenCalled();

    finishSecondSave({ ...defaultPreferences(), settings: { UseMouse: "YES" } });
    await flushMicrotasks();
    expect(first.send).toHaveBeenCalledOnce();
    expect(await first.state.handleApplied({ configuration: {} }, 7)).toBe(true);
    await currentSave;

    expect(first.state.busy.value).toBe(false);
    expect(first.open.value).toBe(false);
    expect(first.finishStatus).toHaveBeenCalledWith(1, "全局偏好已应用");
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
