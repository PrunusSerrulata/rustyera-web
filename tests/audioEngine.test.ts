import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioEngine } from "@/core/audio";
import { defaultPreferences, type FrontendBridge } from "@/core/types";

describe("audio engine scheduling", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});

function playingState(
  revision: number,
  volumeMillionths = 1_000_000,
  resourceId = "sound/theme.mp3",
) {
  return {
    channel_id: 0,
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
    onended: null,
    connect: vi.fn(() => ({ connect: vi.fn() })),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function stubAudioContext(source: ReturnType<typeof sourceNode>) {
  const gains: Array<ReturnType<typeof gainNode>> = [];
  const decode = vi.fn(async () => ({ duration: 1 }) as AudioBuffer);
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
      createBufferSource = vi.fn(() => source);
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
