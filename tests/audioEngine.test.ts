import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioEngine } from "@/core/audio";
import { defaultPreferences, type FrontendBridge } from "@/core/types";

describe("audio engine scheduling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("combines the hot game volume with the existing master volume", async () => {
    const audio = stubAudioContext(sourceNode());
    const preferences = { ...defaultPreferences(), masterVolume: 0.8 };
    const engine = new AudioEngine({} as FrontendBridge, preferences);
    engine.setGameVolume(0.5);
    await engine.unlock();
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.4);

    engine.setGameVolume(0.2);
    expect(audio.gains[0]?.gain.value).toBeCloseTo(0.16);
  });

  it("does not block the runtime while a resource is loading", async () => {
    const resource = deferred<Uint8Array>();
    const source = sourceNode();
    stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1)]);

    expect(bridge.readResource).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    resource.resolve(Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
  });

  it("cancels a pending start when the runtime removes its channel", async () => {
    const resource = deferred<Uint8Array>();
    const source = sourceNode();
    stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1)]);
    await engine.synchronize([]);
    await delay(10);

    expect(bridge.readResource).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  });

  it("reports an asynchronous load failure and allows a retry", async () => {
    const reportError = vi.fn();
    const bridge = {
      readResource: vi
        .fn()
        .mockRejectedValueOnce(new Error("missing audio"))
        .mockResolvedValueOnce(Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    stubAudioContext(sourceNode());
    const engine = new AudioEngine(bridge, defaultPreferences(), reportError);

    await engine.synchronize([playingState(1)]);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(1)]);

    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledTimes(2));
  });

  it("ignores a superseded revision's late failure", async () => {
    const first = deferred<Uint8Array>();
    const second = deferred<Uint8Array>();
    const reportError = vi.fn();
    const bridge = {
      readResource: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    } as unknown as FrontendBridge;
    const source = sourceNode();
    stubAudioContext(source);
    const engine = new AudioEngine(bridge, defaultPreferences(), reportError);

    await engine.synchronize([playingState(1)]);
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(2, 1_000_000, "sound/new.mp3")]);
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledTimes(2));
    first.reject(new Error("obsolete audio"));
    await flushMicrotasks();

    expect(reportError).not.toHaveBeenCalled();
    second.resolve(Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
  });

  it("does not start a superseded revision that finishes late", async () => {
    const first = deferred<Uint8Array>();
    const second = deferred<Uint8Array>();
    const bridge = {
      readResource: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    } as unknown as FrontendBridge;
    const source = sourceNode();
    const audio = stubAudioContext(source);
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1)]);
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(2, 1_000_000, "sound/new.mp3")]);
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledTimes(2));
    first.resolve(Uint8Array.of(1));
    await vi.waitFor(() => expect(audio.decodeAudioData).toHaveBeenCalledOnce());
    await flushMicrotasks();
    expect(source.start).not.toHaveBeenCalled();

    second.resolve(Uint8Array.of(2));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
  });

  it("does not start pending playback after close", async () => {
    const resource = deferred<Uint8Array>();
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const source = sourceNode();
    stubAudioContext(source);
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1)]);
    engine.close();
    await delay(10);

    expect(bridge.readResource).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  });

  it("uses the latest volume received while a revision is pending", async () => {
    const resource = deferred<Uint8Array>();
    const source = sourceNode();
    const { gains } = stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1, 1_000_000)]);
    await engine.synchronize([playingState(1, 250_000)]);
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    resource.resolve(Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());

    expect(gains[1].gain.value).toBe(0.25);
    expect(bridge.readResource).toHaveBeenCalledOnce();
  });

  it("continues the same recoverable track across revision and volume updates", async () => {
    const source = sourceNode();
    const { gains } = stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1)]);
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(2, 250_000)]);

    expect(source.stop).not.toHaveBeenCalled();
    expect(source.start).toHaveBeenCalledOnce();
    expect(gains[1].gain.value).toBe(0.25);
  });

  it("deduplicates a looping effect already started from presentation state", async () => {
    const source = sourceNode();
    stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    await engine.applyEffect({
      action: "play",
      channel_id: 1,
      resource_id: "sound/theme.mp3",
      repeat_count: -1,
      volume_millionths: 1_000_000,
    });

    expect(source.stop).not.toHaveBeenCalled();
    expect(source.start).toHaveBeenCalledOnce();
  });

  it("merges a looping effect into presentation playback before loading starts", async () => {
    const resource = deferred<Uint8Array>();
    const source = sourceNode();
    const { gains, decodeAudioData } = stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);
    await engine.applyEffect({
      action: "play",
      channel_id: 1,
      resource_id: "sound/theme.mp3",
      repeat_count: -1,
      volume_millionths: 250_000,
    });
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    resource.resolve(Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());

    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(source.stop).not.toHaveBeenCalled();
    expect(gains[1].gain.value).toBe(0.25);
  });

  it("executes bare runtime audio effects and can stop the started channel", async () => {
    const source = sourceNode();
    stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.applyEffect({
      action: "play",
      channel_id: 3,
      resource_id: "sound/effect.mp3",
      repeat_count: 0,
      volume_millionths: 500_000,
    });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    await engine.applyEffect({
      action: "stop",
      channel_id: 3,
      resource_id: null,
      repeat_count: 0,
      volume_millionths: 500_000,
    });

    expect(source.stop).toHaveBeenCalledOnce();
  });

  it("keeps one-shot sounds playing concurrently until they end or are stopped", async () => {
    const first = sourceNode();
    const second = sourceNode();
    stubAudioContext(first, second);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const observePlayback = vi.fn();
    const engine = new AudioEngine(bridge, defaultPreferences(), () => undefined, observePlayback);

    await engine.applyEffect(soundEffect("sound/story.mp3"));
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
    await engine.applyEffect(soundEffect("sound/door.mp3"));
    await vi.waitFor(() => expect(second.start).toHaveBeenCalledOnce());

    expect(first.stop).not.toHaveBeenCalled();
    expect(observePlayback).toHaveBeenCalledWith("started", "sound/story.mp3");
    expect(observePlayback).toHaveBeenCalledWith("started", "sound/door.mp3");

    await engine.applyEffect({
      action: "stop",
      channel_id: 0,
      resource_id: null,
      repeat_count: 0,
      volume_millionths: 1_000_000,
    });

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("keeps an active one-shot sound across presentation synchronization", async () => {
    const sound = sourceNode();
    const backgroundMusic = sourceNode();
    stubAudioContext(sound, backgroundMusic);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.applyEffect(soundEffect("sound/story.mp3"));
    await vi.waitFor(() => expect(sound.start).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);
    await vi.waitFor(() => expect(backgroundMusic.start).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);

    expect(sound.stop).not.toHaveBeenCalled();
  });

  it("does not restore a naturally completed one-shot sound from presentation state", async () => {
    const sound = sourceNode();
    const backgroundMusic = sourceNode();
    const { gains } = stubAudioContext(sound, backgroundMusic);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const observePlayback = vi.fn();
    const engine = new AudioEngine(bridge, defaultPreferences(), () => undefined, observePlayback);

    await engine.applyEffect(soundEffect("sound/door.mp3"));
    await vi.waitFor(() => expect(sound.start).toHaveBeenCalledOnce());
    sound.onended?.();
    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);
    await vi.waitFor(() => expect(backgroundMusic.start).toHaveBeenCalledOnce());
    await engine.synchronize([playingState(1, 1_000_000, "sound/theme.mp3", 1)]);

    expect(sound.start).toHaveBeenCalledOnce();
    expect(sound.disconnect).toHaveBeenCalledOnce();
    expect(gains[1].disconnect).toHaveBeenCalledOnce();
    expect(bridge.readResource).toHaveBeenCalledTimes(2);
    expect(observePlayback).toHaveBeenCalledWith("ended", "sound/door.mp3");
  });

  it("reuses the first sound voice only after all ten voices are occupied", async () => {
    const sources = Array.from({ length: 11 }, () => sourceNode());
    stubAudioContext(...sources);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const activeResources = new Set<string>();
    const observePlayback = vi.fn((event: "started" | "ended", resourceId: string) => {
      if (event === "started") activeResources.add(resourceId);
      else activeResources.delete(resourceId);
    });
    const engine = new AudioEngine(bridge, defaultPreferences(), () => undefined, observePlayback);

    for (let index = 0; index < sources.length; index += 1) {
      await engine.applyEffect(soundEffect(`sound/effect-${index}.mp3`));
      await vi.waitFor(() => expect(sources[index].start).toHaveBeenCalledOnce());
    }

    expect(sources[0].stop).toHaveBeenCalledOnce();
    for (const source of sources.slice(1, 10)) expect(source.stop).not.toHaveBeenCalled();
    expect(sources[10].stop).not.toHaveBeenCalled();
    expect(observePlayback).toHaveBeenCalledWith("ended", "sound/effect-0.mp3");
    expect(observePlayback).toHaveBeenLastCalledWith("started", "sound/effect-10.mp3");
    const ended = observePlayback.mock.calls.findIndex(
      ([event, resource]) => event === "ended" && resource === "sound/effect-0.mp3",
    );
    const replacementStarted = observePlayback.mock.calls.findIndex(
      ([event, resource]) => event === "started" && resource === "sound/effect-10.mp3",
    );
    expect(ended).toBeLessThan(replacementStarted);
    expect(activeResources.size).toBe(10);
  });

  it("applies the sound-group volume before and during one-shot loading and playback", async () => {
    const resource = deferred<Uint8Array>();
    const source = sourceNode();
    const { gains } = stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(() => resource.promise),
    } as unknown as FrontendBridge;
    const engine = new AudioEngine(bridge, defaultPreferences());

    await engine.applyEffect(volumeEffect(250_000));
    await engine.applyEffect(soundEffect("sound/door.mp3"));
    await engine.applyEffect(volumeEffect(400_000));
    await vi.waitFor(() => expect(bridge.readResource).toHaveBeenCalledOnce());
    resource.resolve(Uint8Array.of(1, 2, 3));
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());

    expect(gains[1].gain.value).toBe(0.4);
    await engine.applyEffect(volumeEffect(600_000));
    expect(gains[1].gain.value).toBe(0.6);
  });

  it("disconnects a failed start without reporting a playback transition", async () => {
    const source = sourceNode();
    source.start.mockImplementation(() => {
      throw new Error("start failed");
    });
    const { gains } = stubAudioContext(source);
    const bridge = {
      readResource: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    } as unknown as FrontendBridge;
    const reportError = vi.fn();
    const observePlayback = vi.fn();
    const engine = new AudioEngine(bridge, defaultPreferences(), reportError, observePlayback);

    await engine.applyEffect(soundEffect("sound/door.mp3"));
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());

    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(gains[1].disconnect).toHaveBeenCalledOnce();
    expect(observePlayback).not.toHaveBeenCalled();
  });
});

function soundEffect(resourceId: string) {
  return {
    action: "play",
    channel_id: 0,
    resource_id: resourceId,
    repeat_count: 0,
    volume_millionths: 1_000_000,
  };
}

function volumeEffect(volumeMillionths: number) {
  return {
    action: "set_volume",
    channel_id: 0,
    resource_id: null,
    repeat_count: 0,
    volume_millionths: volumeMillionths,
  };
}

function playingState(
  revision: number,
  volumeMillionths = 1_000_000,
  resourceId = "sound/theme.mp3",
  channelId = 0,
) {
  return {
    channel_id: channelId,
    playing: true,
    resource_id: resourceId,
    repeat_count: -1,
    volume_millionths: volumeMillionths,
    revision,
  };
}

function sourceNode() {
  return {
    buffer: undefined,
    loop: false,
    onended: null as (() => void) | null,
    connect: vi.fn(() => ({ connect: vi.fn() })),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function stubAudioContext(...sources: ReturnType<typeof sourceNode>[]) {
  const gains: Array<ReturnType<typeof gainNode>> = [];
  const decode = vi.fn(async () => ({ duration: 1 }) as AudioBuffer);
  let sourceIndex = 0;
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
      createGain = vi.fn(() => {
        const gain = gainNode();
        gains.push(gain);
        return gain;
      });
      createBufferSource = vi.fn(() => sources[Math.min(sourceIndex++, sources.length - 1)]);
      decodeAudioData = decode;
    },
  );
  return { gains, decodeAudioData: decode };
}

function gainNode() {
  return {
    gain: { value: 1 },
    connect: vi.fn(() => ({ connect: vi.fn() })),
    disconnect: vi.fn(),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
