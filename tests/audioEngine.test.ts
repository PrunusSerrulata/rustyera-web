import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioEngine, AudioProviderError } from "@/core/audio";
import {
  parseAudioEffect,
  parseAudioStates,
  type AudioEffectProjection,
  type AudioStateProjection,
} from "@/core/audio/model";
import { RuntimeServiceError } from "@/core/runtimeServiceProtocol";
import { defaultPreferences, type FrontendBridge } from "@/core/types";

describe("media-element audio provider", () => {
  let media: MediaHarness;
  let bridge: FrontendBridge;

  beforeEach(() => {
    media = installMediaHarness();
    bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("decodes the lossless bigint shape emitted by the WASM protocol bridge", () => {
    expect(
      parseAudioEffect({
        channel: { type: "sound", channel: 3n },
        action: "pause",
        resource_id: null,
        repeat_count: 0n,
        volume_millionths: 1_000_000n,
        revision: 9n,
        rate_millionths: 2_500_000n,
        preserve_pitch: false,
      }),
    ).toEqual({
      channel: { type: "sound", channel: 3 },
      action: "pause",
      resourceId: null,
      repeatCount: 0,
      volumeMillionths: 1_000_000,
      revision: 9n,
      rateMillionths: 2_500_000,
      preservePitch: false,
    });
    expect(
      parseAudioStates([
        {
          channel: { type: "sound", channel: 3n },
          resource_id: "sound/tone.wav",
          repeat_count: 2n,
          volume_millionths: 500_000n,
          state: "playing",
          revision: 10n,
          rate_millionths: 1_000_000n,
          preserve_pitch: true,
        },
      ]),
    ).toEqual([
      {
        channel: { type: "sound", channel: 3 },
        resourceId: "sound/tone.wav",
        repeatCount: 2,
        volumeMillionths: 500_000,
        state: "playing",
        revision: 10n,
        rateMillionths: 1_000_000,
        preservePitch: true,
      },
    ]);
  });

  it("advertises only a complete media provider and unlocks the shared audio context", async () => {
    const preferences = { ...defaultPreferences(), masterVolume: 0.4 };
    const engine = new AudioEngine(bridge, preferences);

    expect(engine.providerAvailable()).toBe(false);
    await expect(engine.unlock()).resolves.toBe(true);
    expect(engine.providerAvailable()).toBe(true);
    expect(media.context.resume).toHaveBeenCalledOnce();
    expect(media.context.createMediaElementSource).not.toHaveBeenCalled();
    expect(media.targetElements()).toHaveLength(11);
    expect(media.targetElements().every((target) => target.volume === 0.4)).toBe(true);

    engine.setGameVolume(0.25);
    expect(media.targetElements().every((target) => target.volume === 0.1)).toBe(true);
  });

  it("creates ten stable sound targets and one BGM target", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    await engine.applyEffect(playEffect(sound(0), 1, "sound/zero.wav"));
    await engine.applyEffect(playEffect(sound(9), 2, "sound/nine.wav"));
    await engine.applyEffect(playEffect(bgm(), 3, "sound/theme.wav", -1));

    expect(media.targetElements()).toHaveLength(11);
    expect(media.target(0).play).toHaveBeenCalledOnce();
    expect(media.target(9).play).toHaveBeenCalledOnce();
    expect(media.target(10).play).toHaveBeenCalledOnce();
    expect(media.target(10).loop).toBe(true);
    expect(engine.memoryCounters()).toEqual({ count: 3, estimatedBytes: 9 });
  });

  it("pauses, observes a stable position, resumes, and reports real state", async () => {
    vi.spyOn(performance, "now").mockReturnValue(12.5);
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(3), 7, "sound/tone.wav"));
    const target = media.target(3);
    target.currentTime = 1.234;

    await engine.applyEffect(controlEffect(sound(3), "pause", 8));
    expect(target.pause).toHaveBeenCalledOnce();
    expect(observation(engine, soundService(3), 8)).toEqual(
      new Map<number, unknown>([
        [0, [0, [3]]],
        [1, 8],
        [2, 2_500],
        [3, 1_234],
        [4, 2],
        [5, 1_000_000],
        [6, 1_000_000],
        [7, true],
        [8, 12_500_000],
      ]),
    );

    await engine.applyEffect(controlEffect(sound(3), "resume", 9));
    expect(target.currentTime).toBe(1.234);
    expect(observation(engine, soundService(3), 9).get(4)).toBe(1);
  });

  it("preserves and restores the observed position when WebKit resets currentTime on pause", async () => {
    media.resetCurrentTimeOnPause = true;
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(3), 7, "sound/tone.wav"));
    const target = media.target(3);
    target.currentTime = 1.234;

    await engine.applyEffect(controlEffect(sound(3), "pause", 8));

    expect(target.currentTime).toBe(0);
    expect(observation(engine, soundService(3), 8).get(3)).toBe(1_234);
    expect(engine.providerSnapshot()["sound:3"]?.positionMs).toBe(1_234);

    await engine.applyEffect(controlEffect(sound(3), "resume", 9));

    expect(target.currentTime).toBe(1.234);
    expect(observation(engine, soundService(3), 9).get(3)).toBe(1_234);
    expect(observation(engine, soundService(3), 9).get(4)).toBe(1);
  });

  it("updates rate and standard preserve-pitch before continuing provider time", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(2), 1, "sound/tone.wav"));
    const target = media.target(2);
    target.currentTime = 0.75;

    await engine.applyEffect({
      ...controlEffect(sound(2), "set_rate", 2),
      rateMillionths: 2_500_000,
      preservePitch: false,
    });

    expect(target.currentTime).toBe(0.75);
    expect(target.playbackRate).toBe(2.5);
    expect(target.preservesPitch).toBe(false);
    expect(observation(engine, soundService(2), 2).get(6)).toBe(2_500_000);
    expect(observation(engine, soundService(2), 2).get(7)).toBe(false);
  });

  it("observes values accepted by the provider instead of cached command values", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(2), 1, "sound/tone.wav"));
    await engine.applyEffect({
      ...controlEffect(sound(2), "set_rate", 2),
      rateMillionths: 2_500_000,
      preservePitch: false,
    });
    await engine.applyEffect({
      ...controlEffect(sound(2), "set_volume", 3),
      volumeMillionths: 370_000,
    });

    media.target(2).playbackRate = 1.75;
    media.target(2).preservesPitch = true;
    media.target(2).volume = 0.42;

    const actual = observation(engine, soundService(2), 3);
    expect([actual.get(5), actual.get(6), actual.get(7)]).toEqual([420_000, 1_750_000, true]);
  });

  it("uses the WebKit preserve-pitch fallback", async () => {
    media.useWebkitPitch = true;
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(4), 1, "sound/tone.wav"));
    const target = media.target(4);

    await engine.applyEffect({
      ...controlEffect(sound(4), "set_rate", 2),
      rateMillionths: 500_000,
      preservePitch: false,
    });

    expect(target.webkitPreservesPitch).toBe(false);
  });

  it("plays a finite repeat count and releases the resource after natural completion", async () => {
    const observePlayback = vi.fn();
    const engine = new AudioEngine(bridge, defaultPreferences(), () => undefined, observePlayback);
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(1), 3, "sound/repeat.wav", 2));
    const target = media.target(1);

    target.finish();
    await flushMicrotasks();
    expect(target.play).toHaveBeenCalledTimes(2);
    expect(engine.memoryCounters().count).toBe(1);

    target.finish();
    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    expect(media.revokeObjectURL).toHaveBeenCalledOnce();
    expect(observePlayback.mock.calls).toEqual([
      ["started", "sound/repeat.wav"],
      ["ended", "sound/repeat.wav"],
    ]);
    expect(observation(engine, soundService(1), 3).get(4)).toBe(0);
  });

  it("overwrites one exact target without disturbing other sound targets", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(0), 1, "sound/first.wav"));
    await engine.applyEffect(playEffect(sound(1), 2, "sound/other.wav"));
    await engine.applyEffect(playEffect(sound(0), 3, "sound/replacement.wav"));

    expect(media.target(0).pause).toHaveBeenCalledOnce();
    expect(media.target(1).pause).not.toHaveBeenCalled();
    expect(media.revokeObjectURL).toHaveBeenCalledOnce();
    expect(observation(engine, soundService(0), 3).get(4)).toBe(1);
    expect(observation(engine, soundService(1), 2).get(4)).toBe(1);
  });

  it("stops one exact target, releases its URL, and retains its revision", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(6), 4, "sound/tone.wav"));
    const target = media.target(6);
    target.currentTime = 1.25;
    await engine.applyEffect(controlEffect(sound(6), "stop", 5));

    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    expect(target.removeAttribute).toHaveBeenCalledWith("src");
    expect(target.load).toHaveBeenCalledOnce();
    expect(engine.providerSnapshot()["sound:6"]).toMatchObject({
      state: "stopped",
      durationMs: 0,
      positionMs: 0,
      resourceId: null,
    });
    const stopped = observation(engine, soundService(6), 5);
    expect([stopped.get(1), stopped.get(2), stopped.get(3), stopped.get(4)]).toEqual([5, 0, 0, 0]);
  });

  it("deduplicates the same revision and rejects an older effect", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    const effect = playEffect(bgm(), 10, "sound/theme.wav", -1);
    await engine.applyEffect(effect);
    await engine.applyEffect(effect);

    expect(bridge.readResource).toHaveBeenCalledOnce();
    expect(media.target(10).play).toHaveBeenCalledOnce();
    await expect(engine.applyEffect(controlEffect(bgm(), "pause", 9))).rejects.toMatchObject({
      code: "frontend.stale_audio_effect",
    });
  });

  it("rejects a stale observation instead of returning a plausible state", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(5), 11, "sound/tone.wav"));

    expect(() => observation(engine, soundService(5), 10)).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({ category: "stale_response" }),
    );
    expect(() =>
      engine.observe(
        new Map<number, unknown>([
          [0, [0, [10]]],
          [1, 0],
        ]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({ category: "invalid_request" }),
    );
  });

  it("retains a structured failure at the accepted revision after resource failure", async () => {
    vi.mocked(bridge.readResource).mockRejectedValueOnce(new Error("missing audio"));
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    await expect(engine.applyEffect(playEffect(sound(7), 12, "sound/missing.wav"))).rejects.toThrow(
      "missing audio",
    );
    expect(() => observation(engine, soundService(7), 12)).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({
        category: "backend_failure",
      }),
    );
  });

  it("rejects a real metadata error and retains the failure at its revision", async () => {
    media.metadataReady = false;
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    const applying = engine.applyEffect(playEffect(sound(7), 14, "sound/corrupt.wav"));
    await flushMicrotasks();
    media.target(7).failDecode();

    await expect(applying).rejects.toMatchObject({ code: "frontend.audio_decode_failed" });
    expect(() => observation(engine, soundService(7), 14)).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({ category: "backend_failure" }),
    );
  });

  it("cancels a pending resource read without waiting for the bridge promise", async () => {
    let resolveRead!: (value: Uint8Array) => void;
    bridge.readResource = vi.fn(
      () => new Promise<Uint8Array>((resolve) => (resolveRead = resolve)),
    );
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    const applying = engine.applyEffect(playEffect(sound(0), 15, "sound/slow.wav"));
    await flushMicrotasks();
    engine.resetResources(1);

    await expect(applying).resolves.toBeUndefined();
    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    resolveRead(Uint8Array.of(1));
  });

  it("cancels a pending metadata wait and revokes its object URL", async () => {
    media.metadataReady = false;
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    const applying = engine.applyEffect(playEffect(sound(1), 16, "sound/slow-metadata.wav"));
    await flushMicrotasks();
    engine.resetResources(2);

    await expect(applying).resolves.toBeUndefined();
    expect(media.revokeObjectURL).toHaveBeenCalledOnce();
    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
  });

  it("bounds metadata waits with a structured provider timeout", async () => {
    vi.useFakeTimers();
    media.metadataReady = false;
    const engine = new AudioEngine(
      bridge,
      defaultPreferences(),
      () => undefined,
      undefined,
      1024,
      25,
    );
    await engine.unlock();

    const applying = engine.applyEffect(playEffect(sound(1), 17, "sound/no-metadata.wav"));
    const rejected = expect(applying).rejects.toMatchObject({
      code: "frontend.audio_metadata_timeout",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    vi.useRealTimers();
  });

  it("reports autoplay failure, releases media, and does not forge stopped success", async () => {
    media.rejectNextPlay = new DOMException("blocked", "NotAllowedError");
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();

    await expect(engine.applyEffect(playEffect(sound(8), 13, "sound/blocked.wav"))).rejects.toEqual(
      expect.objectContaining<Partial<AudioProviderError>>({
        code: "frontend.audio_autoplay_failed",
      }),
    );
    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    expect(() => observation(engine, soundService(8), 13)).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({ category: "backend_failure" }),
    );
  });

  it("restores BGM presentation state without replaying transient sounds", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(0), 2, "sound/transient.wav"));
    await engine.synchronize([bgmState(20, "paused")]);

    expect(media.target(0).play).toHaveBeenCalledOnce();
    expect(media.target(10).play).not.toHaveBeenCalled();
    expect(observation(engine, bgmService(), 20).get(4)).toBe(2);

    await engine.synchronize([bgmState(21, "playing")]);
    expect(media.target(10).play).toHaveBeenCalledOnce();
    expect(observation(engine, bgmService(), 21).get(4)).toBe(1);
  });

  it("releases absent BGM presentation state without accepting an older effect", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(bgm(), 12, "sound/theme.wav", -1));

    await engine.synchronize([]);

    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    expect(engine.providerSnapshot().bgm?.revision).toBe(12);
    await expect(engine.applyEffect(controlEffect(bgm(), "pause", 11))).rejects.toMatchObject({
      code: "frontend.stale_audio_effect",
    });
  });

  it("clears an older BGM failure after a higher revision synchronizes successfully", async () => {
    media.metadataReady = false;
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    const failed = engine.applyEffect(playEffect(bgm(), 20, "sound/corrupt.wav", -1));
    await flushMicrotasks();
    media.target(10).failDecode();
    await expect(failed).rejects.toMatchObject({ code: "frontend.audio_decode_failed" });

    media.target(10).succeedMetadata();
    await engine.synchronize([bgmState(21, "playing")]);

    expect(observation(engine, bgmService(), 21).get(4)).toBe(1);
  });

  it("clears all target resources and revisions on project generation reset", async () => {
    const engine = new AudioEngine(bridge, defaultPreferences());
    await engine.unlock();
    await engine.applyEffect(playEffect(sound(0), 4, "sound/tone.wav"));
    await engine.applyEffect(playEffect(bgm(), 5, "sound/theme.wav", -1));

    engine.resetResources(7);

    expect(media.context.close).not.toHaveBeenCalled();
    expect(media.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(engine.memoryCounters()).toEqual({ count: 0, estimatedBytes: 0 });
    expect(observation(engine, soundService(0), 0).get(4)).toBe(0);
    expect(observation(engine, bgmService(), 0).get(4)).toBe(0);
  });

  it("fails closed when preserve-pitch support is absent", async () => {
    media.pitchSupported = false;
    const engine = new AudioEngine(bridge, defaultPreferences());

    expect(engine.providerAvailable()).toBe(false);
    await expect(engine.unlock()).rejects.toMatchObject({
      code: "frontend.audio_provider_unavailable",
    });
    expect(() =>
      engine.observe(
        new Map<number, unknown>([
          [0, [1, []]],
          [1, 0],
        ]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeServiceError>>({ category: "unsupported" }),
    );
  });

  it("rolls back partial target initialization and never advertises it", async () => {
    media.failAudioAt = 4;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await expect(engine.unlock()).rejects.toMatchObject({
      code: "frontend.audio_provider_unavailable",
    });
    expect(engine.providerAvailable()).toBe(false);
    expect(media.targetElements()).toHaveLength(3);
    expect(media.targetElements().every((target) => target.onended == null)).toBe(true);
    expect(media.targetElements().every((target) => target.onerror == null)).toBe(true);
    expect(media.context.close).toHaveBeenCalledOnce();
  });
});

function sound(channel: number) {
  return { type: "sound", channel } as const;
}

function bgm() {
  return { type: "bgm" } as const;
}

function playEffect(
  channel: ReturnType<typeof sound> | ReturnType<typeof bgm>,
  revision: number,
  resourceId: string,
  repeatCount = 1,
): AudioEffectProjection {
  return {
    channel,
    action: "play",
    resourceId,
    repeatCount,
    volumeMillionths: 1_000_000,
    revision,
    rateMillionths: 1_000_000,
    preservePitch: true,
  };
}

function controlEffect(
  channel: ReturnType<typeof sound> | ReturnType<typeof bgm>,
  action: "stop" | "set_volume" | "pause" | "resume" | "set_rate",
  revision: number,
): AudioEffectProjection {
  return {
    channel,
    action,
    resourceId: null,
    repeatCount: 0,
    volumeMillionths: 1_000_000,
    revision,
    rateMillionths: 1_000_000,
    preservePitch: true,
  };
}

function bgmState(revision: number, state: "playing" | "paused"): AudioStateProjection {
  return {
    channel: bgm(),
    resourceId: "sound/theme.wav",
    repeatCount: -1,
    volumeMillionths: 500_000,
    state,
    revision,
    rateMillionths: 1_000_000,
    preservePitch: true,
  };
}

function soundService(channel: number) {
  return [0, [channel]];
}

function bgmService() {
  return [1, []];
}

function observation(engine: AudioEngine, channel: unknown, revision: number) {
  return engine.observe(
    new Map<number, unknown>([
      [0, channel],
      [1, revision],
    ]),
  );
}

interface FakeAudioElement extends EventTarget {
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  preload: string;
  paused: boolean;
  ended: boolean;
  duration: number;
  currentTime: number;
  playbackRate: number;
  volume: number;
  loop: boolean;
  src: string;
  readyState: number;
  error: MediaError | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  finish(): void;
  succeedMetadata(): void;
  failDecode(code?: number): void;
}

interface MediaHarness {
  context: {
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    createMediaElementSource: ReturnType<typeof vi.fn>;
  };
  pitchSupported: boolean;
  useWebkitPitch: boolean;
  metadataReady: boolean;
  failAudioAt?: number;
  rejectNextPlay?: unknown;
  resetCurrentTimeOnPause: boolean;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  targetElements(): FakeAudioElement[];
  target(index: number): FakeAudioElement;
}

function installMediaHarness(): MediaHarness {
  const elements: FakeAudioElement[] = [];
  const resume = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const createMediaElementSource = vi.fn(() => {
    throw new Error("media elements must not use the WebKit source-node rate path");
  });
  const revokeObjectURL = vi.fn();
  let nextUrl = 0;
  let audioAttempt = 0;
  const harness: MediaHarness = {
    context: { resume, close, createMediaElementSource },
    pitchSupported: true,
    useWebkitPitch: false,
    metadataReady: true,
    resetCurrentTimeOnPause: false,
    revokeObjectURL,
    targetElements: () => elements,
    target: (index) => elements[index]!,
  };

  class FakeAudio extends EventTarget implements FakeAudioElement {
    declare preservesPitch?: boolean;
    declare webkitPreservesPitch?: boolean;
    preload = "";
    paused = true;
    ended = false;
    duration = 2.5;
    currentTime = 0;
    playbackRate = 1;
    volume = 1;
    loop = false;
    src = "";
    readyState: number;
    error: MediaError | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(async () => {
      if (harness.rejectNextPlay) {
        const error = harness.rejectNextPlay;
        harness.rejectNextPlay = undefined;
        throw error;
      }
      this.paused = false;
      this.ended = false;
    });
    pause = vi.fn(() => {
      this.paused = true;
      if (harness.resetCurrentTimeOnPause) this.currentTime = 0;
    });
    load = vi.fn(() => {
      if (!this.src) {
        this.paused = true;
        this.ended = false;
        this.duration = Number.NaN;
        this.currentTime = 0;
      } else if (!Number.isFinite(this.duration)) this.duration = 2.5;
    });
    removeAttribute = vi.fn((name: string) => {
      if (name === "src") this.src = "";
    });

    constructor() {
      super();
      audioAttempt += 1;
      if (harness.failAudioAt === audioAttempt)
        throw new Error("audio target initialization failed");
      this.readyState = harness.metadataReady ? 1 : 0;
      if (harness.pitchSupported) {
        if (harness.useWebkitPitch) this.webkitPreservesPitch = true;
        else this.preservesPitch = true;
      }
      elements.push(this);
    }

    finish(): void {
      this.paused = true;
      this.ended = true;
      this.onended?.();
    }

    succeedMetadata(): void {
      this.readyState = 1;
      this.dispatchEvent(new Event("loadedmetadata"));
    }

    failDecode(code = 3): void {
      this.error = { code } as MediaError;
      this.onerror?.();
      this.dispatchEvent(new Event("error"));
    }
  }

  class FakeAudioContext {
    state = "running";
    resume = resume;
    close = close;
    createMediaElementSource = createMediaElementSource;
  }

  const OriginalUrl = URL;
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "URL",
    class extends OriginalUrl {
      static createObjectURL = vi.fn(() => `blob:audio-${++nextUrl}`);
      static revokeObjectURL = revokeObjectURL;
    },
  );
  return harness;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}
