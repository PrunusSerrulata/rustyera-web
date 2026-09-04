import type { FrontendBridge, Preferences } from "@/core/types";
import { mapOf } from "@/core/runtimeSupport";
import {
  RuntimeServiceError,
  sameServiceInteger,
  serviceInteger,
  serviceMap,
  type ServiceInteger,
} from "@/core/runtimeServiceProtocol";
import {
  SOUND_VOICE_COUNT,
  audioTargetKey,
  type AudioEffectProjection,
  type AudioPlaybackState,
  type AudioStateProjection,
  type AudioTargetChannel,
  type AudioTargetResource,
  type MediaAudioTarget,
  type PendingAudioLoad,
} from "@/core/audio/model";

export type AudioPlaybackEvent = "started" | "ended";

const DEFAULT_AUDIO_RESOURCE_BUDGET_BYTES = 128 * 1024 * 1024;
const MAXIMUM_ENCODED_AUDIO_BYTES = 64 * 1024 * 1024;
const DEFAULT_METADATA_TIMEOUT_MS = 15_000;
const ONE_MILLION = 1_000_000;
const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
});

type ProviderReadiness = "uninitialized" | "ready" | "unavailable";

export interface AudioMemoryCounters {
  count: number;
  estimatedBytes: number;
}

export interface AudioProviderTargetSnapshot {
  revision: ServiceInteger;
  resourceId: string | null;
  pending: boolean;
  state: AudioPlaybackState;
  durationMs: number;
  positionMs: number;
  volumeMillionths: number;
  rateMillionths: number;
  preservePitch: boolean;
  failure: string | null;
}

export class AudioProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AudioProviderError";
  }
}

class AudioLoadCancelled extends Error {
  constructor() {
    super("audio load was cancelled");
    this.name = "AudioLoadCancelled";
  }
}

export class AudioEngine {
  private context?: AudioContext;
  private targets?: Map<string, MediaAudioTarget>;
  private gameVolume = 1;
  private resourceGeneration = 0;
  private retainedBytes = 0;
  private readiness: ProviderReadiness = "uninitialized";

  constructor(
    private readonly bridge: FrontendBridge,
    private preferences: Preferences,
    private readonly reportError: (error: unknown) => void = () => undefined,
    private readonly observePlayback?: (event: AudioPlaybackEvent, resourceId: string) => void,
    private readonly resourceBudgetBytes = DEFAULT_AUDIO_RESOURCE_BUDGET_BYTES,
    private readonly metadataTimeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
  ) {}

  providerAvailable(): boolean {
    return this.readiness === "ready";
  }

  async unlock(): Promise<boolean> {
    const context = this.initializeProvider();
    await context.resume();
    return context.state === "running";
  }

  setPreferences(preferences: Preferences): void {
    this.preferences = preferences;
    this.applyMasterVolume();
  }

  setGameVolume(volume: number): void {
    this.gameVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    this.applyMasterVolume();
  }

  async synchronize(states: AudioStateProjection[]): Promise<void> {
    if (!this.providerAvailable()) {
      if (states.length === 0) return;
      throw new AudioProviderError(
        "frontend.audio_provider_unavailable",
        "media-element audio provider is unavailable",
      );
    }
    const target = this.target({ type: "bgm" });
    const bgm = states.find((state) => state.channel.type === "bgm");
    if (!bgm) {
      this.releaseTargetPlayback(target);
      target.failure = undefined;
      return;
    }
    if (BigInt(bgm.revision) < BigInt(target.revision)) return;
    target.failure = undefined;
    try {
      if (bgm.state === "stopped") {
        target.revision = bgm.revision;
        this.releaseTargetPlayback(target);
        return;
      }
      if (
        !sameServiceInteger(target.revision, bgm.revision) ||
        target.resource?.resourceId !== bgm.resourceId
      ) {
        await this.replacePlayback(target, bgm, bgm.state === "playing");
      } else {
        this.applyTargetSettings(target, bgm);
        if (bgm.state === "playing" && target.element.paused) await this.resume(target);
      }
      if (bgm.state === "paused" && !target.element.paused) this.pause(target);
      target.failure = undefined;
    } catch (error) {
      if (!(error instanceof AudioLoadCancelled)) target.failure = stableAudioFailure(error);
      throw error;
    }
  }

  async applyEffect(effect: AudioEffectProjection): Promise<void> {
    const target = this.target(effect.channel);
    if (BigInt(effect.revision) < BigInt(target.revision))
      throw new AudioProviderError(
        "frontend.stale_audio_effect",
        `audio effect revision ${String(effect.revision)} precedes ${String(target.revision)}`,
      );
    target.failure = undefined;
    try {
      if (effect.action === "play") {
        if (
          sameServiceInteger(target.revision, effect.revision) &&
          target.resource?.resourceId === effect.resourceId &&
          target.resource.metadataReady
        ) {
          this.applyTargetSettings(target, effect);
          if (target.element.paused) await this.resume(target);
          return;
        }
        await this.replacePlayback(target, effect, true);
        return;
      }
      target.revision = effect.revision;
      switch (effect.action) {
        case "stop":
          this.releaseTargetPlayback(target);
          break;
        case "set_volume":
          this.setTargetVolume(target, effect.volumeMillionths);
          break;
        case "pause":
          this.pause(target);
          break;
        case "resume":
          await this.resume(target);
          break;
        case "set_rate":
          this.setTargetRate(target, effect.rateMillionths, effect.preservePitch);
          break;
      }
    } catch (error) {
      if (!(error instanceof AudioLoadCancelled)) target.failure = stableAudioFailure(error);
      throw error;
    }
  }

  observe(query: unknown): Map<number, unknown> {
    if (!this.providerAvailable())
      throw new RuntimeServiceError("unsupported", "audio observation provider is unavailable");
    const fields = serviceMap(query, [0, 1], "audio observation");
    const channel = parseServiceChannel(fields.get(0));
    const expectedRevision = serviceInteger(fields.get(1), "audio observation revision");
    const target = this.target(channel);
    if (!sameServiceInteger(expectedRevision, target.revision))
      throw new RuntimeServiceError(
        "stale_response",
        `audio revision ${String(target.revision)} does not match ${String(expectedRevision)}`,
      );
    if (target.failure) throw new RuntimeServiceError("backend_failure", target.failure);
    const observation = this.actualTargetState(target);
    return mapOf(
      [0, serviceChannel(channel)],
      [1, target.revision],
      [2, observation.durationMs],
      [3, observation.state === "stopped" ? 0 : observation.positionMs],
      [4, observation.state === "stopped" ? 0 : observation.state === "playing" ? 1 : 2],
      [5, observation.volumeMillionths],
      [6, observation.rateMillionths],
      [7, observation.preservePitch],
      [8, monotonicTimeNanoseconds()],
    );
  }

  providerSnapshot(): Record<string, AudioProviderTargetSnapshot> {
    if (!this.targets) return {};
    return Object.fromEntries(
      [...this.targets.entries()].map(([key, target]) => {
        let observation: ReturnType<AudioEngine["actualTargetState"]>;
        let failure = target.failure ?? null;
        try {
          observation = this.actualTargetState(target);
        } catch (error) {
          observation = {
            state: targetState(target),
            durationMs: target.resource ? milliseconds(target.element.duration) : 0,
            positionMs: providerPositionMs(target),
            volumeMillionths: 0,
            rateMillionths: 0,
            preservePitch: false,
          };
          failure ??= stableAudioFailure(error);
        }
        return [
          key,
          {
            revision: target.revision,
            resourceId: target.resource?.resourceId ?? null,
            pending: target.pendingLoad != null,
            ...observation,
            failure,
          },
        ];
      }),
    );
  }

  cancelPendingLoads(): void {
    if (!this.targets) return;
    for (const target of this.targets.values()) this.cancelPendingLoad(target);
  }

  close(): void {
    this.teardownProvider("unavailable");
  }

  resetResources(generation: number): void {
    if (this.targets) {
      for (const target of this.targets.values()) {
        this.releaseTargetPlayback(target);
        target.revision = 0;
        target.failure = undefined;
      }
    }
    this.retainedBytes = 0;
    this.resourceGeneration = generation;
  }

  memoryCounters(): AudioMemoryCounters {
    return {
      count: this.targets
        ? [...this.targets.values()].filter((target) => target.resource).length
        : 0,
      estimatedBytes: this.retainedBytes,
    };
  }

  private initializeProvider(): AudioContext {
    if (this.readiness === "ready") return this.context!;
    if (this.readiness === "unavailable")
      throw new AudioProviderError(
        "frontend.audio_provider_unavailable",
        "media-element audio provider is unavailable",
      );
    let context: AudioContext | undefined;
    const targets = new Map<string, MediaAudioTarget>();
    try {
      if (
        typeof Audio !== "function" ||
        typeof AudioContext !== "function" ||
        typeof URL.createObjectURL !== "function" ||
        typeof URL.revokeObjectURL !== "function"
      )
        throw new Error("required browser media APIs are absent");
      // Keep AudioContext as the user-gesture unlock gate, but let each media element output
      // directly. WebKit bug 240405 makes non-1x playback through MediaElementAudioSourceNode
      // unreliable; direct elements preserve the standard pause/stop/rate semantics.
      context = new AudioContext();
      for (const channel of audioChannels()) {
        const element = new Audio();
        element.preload = "auto";
        if (!pitchProperty(element)) throw new Error("preserve-pitch property is absent");
        const target: MediaAudioTarget = {
          channel,
          element,
          revision: 0,
          volumeMillionths: ONE_MILLION,
          rateMillionths: ONE_MILLION,
          preservePitch: true,
          positionFloorMs: 0,
        };
        targets.set(audioTargetKey(channel), target);
        this.applyEffectiveTargetVolume(target);
        element.onended = () => this.handleEnded(target);
        element.onerror = () => this.handleMediaError(target);
      }
      this.context = context;
      this.targets = targets;
      this.readiness = "ready";
      return context;
    } catch (error) {
      clearProviderTargetHandlers(targets);
      if (typeof context?.close === "function") void context.close().catch(this.reportError);
      this.context = undefined;
      this.targets = undefined;
      this.readiness = "unavailable";
      throw new AudioProviderError(
        "frontend.audio_provider_unavailable",
        `media-element audio provider initialization failed: ${String(error)}`,
      );
    }
  }

  private target(channel: AudioTargetChannel): MediaAudioTarget {
    if (this.readiness !== "ready" || !this.targets)
      throw new AudioProviderError(
        "frontend.audio_provider_unavailable",
        "media-element audio provider is not initialized",
      );
    const target = this.targets.get(audioTargetKey(channel));
    if (!target) throw new RuntimeServiceError("invalid_request", "audio target is out of range");
    return target;
  }

  private applyMasterVolume(): void {
    if (!this.targets) return;
    for (const target of this.targets.values()) this.applyEffectiveTargetVolume(target);
  }

  private async replacePlayback(
    target: MediaAudioTarget,
    state: AudioStateProjection | Extract<AudioEffectProjection, { action: "play" }>,
    start: boolean,
  ): Promise<void> {
    const revision = state.revision;
    target.revision = revision;
    this.releaseTargetPlayback(target);
    this.applyTargetSettings(target, state);
    const pending: PendingAudioLoad = {
      revision,
      generation: this.resourceGeneration,
      resourceId: state.resourceId,
      controller: new AbortController(),
    };
    target.pendingLoad = pending;
    let resource: AudioTargetResource | undefined;
    try {
      const bytes = await abortableResourceRead(
        this.bridge.readResource(state.resourceId),
        pending.controller.signal,
      ).catch((error) => {
        if (error instanceof AudioLoadCancelled) throw error;
        throw new AudioProviderError(
          "frontend.audio_resource_failed",
          `audio resource ${state.resourceId} could not be read: ${String(error)}`,
        );
      });
      if (!this.ownsPendingLoad(target, pending)) throw new AudioLoadCancelled();
      if (bytes.byteLength > MAXIMUM_ENCODED_AUDIO_BYTES)
        throw new AudioProviderError(
          "frontend.audio_resource_limit",
          `audio resource exceeds ${MAXIMUM_ENCODED_AUDIO_BYTES} bytes`,
        );
      if (this.retainedBytes + bytes.byteLength > this.resourceBudgetBytes)
        throw new AudioProviderError(
          "frontend.audio_resource_limit",
          `retained audio exceeds ${this.resourceBudgetBytes} bytes`,
        );
      const objectUrl = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: audioMimeType(state.resourceId) }),
      );
      if (!this.ownsPendingLoad(target, pending)) {
        URL.revokeObjectURL(objectUrl);
        throw new AudioLoadCancelled();
      }
      resource = {
        resourceId: state.resourceId,
        objectUrl,
        bytes: bytes.byteLength,
        remainingPlays: state.repeatCount,
        started: false,
        metadataReady: false,
        controller: pending.controller,
      };
      target.resource = resource;
      target.positionFloorMs = 0;
      this.retainedBytes += resource.bytes;
      target.element.loop = resource.remainingPlays < 0;
      target.element.src = objectUrl;
      const metadata = waitForMetadata(
        target.element,
        pending.controller.signal,
        this.metadataTimeoutMs,
        state.resourceId,
      );
      target.element.load();
      await metadata;
      if (!this.ownsPendingLoad(target, pending) || target.resource !== resource)
        throw new AudioLoadCancelled();
      resource.metadataReady = true;
      target.pendingLoad = undefined;
      if (start) await this.resume(target);
    } catch (error) {
      if (target.pendingLoad === pending) target.pendingLoad = undefined;
      if (resource && target.resource === resource) this.releaseActiveResource(target);
      if (error instanceof AudioLoadCancelled) return;
      throw error;
    }
  }

  private ownsPendingLoad(target: MediaAudioTarget, pending: PendingAudioLoad): boolean {
    return (
      target.pendingLoad === pending &&
      pending.generation === this.resourceGeneration &&
      sameServiceInteger(target.revision, pending.revision) &&
      !pending.controller.signal.aborted
    );
  }

  private applyTargetSettings(
    target: MediaAudioTarget,
    value: Pick<AudioStateProjection, "volumeMillionths" | "rateMillionths" | "preservePitch">,
  ): void {
    this.setTargetVolume(target, value.volumeMillionths);
    this.setTargetRate(target, value.rateMillionths, value.preservePitch);
  }

  private setTargetVolume(target: MediaAudioTarget, volume: number): void {
    target.volumeMillionths = volume;
    this.applyEffectiveTargetVolume(target);
  }

  private applyEffectiveTargetVolume(target: MediaAudioTarget): void {
    target.element.volume = (target.volumeMillionths / ONE_MILLION) * this.outputVolumeScale();
  }

  private outputVolumeScale(): number {
    const master = Number.isFinite(this.preferences.masterVolume)
      ? Math.min(1, Math.max(0, this.preferences.masterVolume))
      : 1;
    return master * this.gameVolume;
  }

  private setTargetRate(target: MediaAudioTarget, rate: number, preservePitch: boolean): void {
    const property = pitchProperty(target.element);
    if (!property)
      throw new AudioProviderError(
        "frontend.audio_pitch_unsupported",
        "media element exposes no preserve-pitch property",
      );
    this.preservePosition(target);
    target.element.playbackRate = rate / ONE_MILLION;
    writePitch(target.element, property, preservePitch);
    target.rateMillionths = rate;
    target.preservePitch = preservePitch;
  }

  private async resume(target: MediaAudioTarget): Promise<void> {
    const resource = target.resource;
    if (!resource || !resource.metadataReady) return;
    try {
      if (milliseconds(target.element.currentTime) < target.positionFloorMs)
        target.element.currentTime = target.positionFloorMs / 1_000;
      await target.element.play();
      if (target.resource !== resource) return;
      if (!resource.started) {
        resource.started = true;
        this.observePlayback?.("started", resource.resourceId);
      }
    } catch (error) {
      if (target.resource === resource) this.releaseActiveResource(target);
      throw new AudioProviderError(
        "frontend.audio_autoplay_failed",
        `media playback failed for ${resource.resourceId}: ${String(error)}`,
      );
    }
  }

  private handleEnded(target: MediaAudioTarget): void {
    const resource = target.resource;
    if (!resource?.metadataReady) return;
    if (resource.remainingPlays > 1) {
      resource.remainingPlays -= 1;
      target.positionFloorMs = 0;
      target.element.currentTime = 0;
      void target.element.play().catch((error) => {
        if (target.resource !== resource) return;
        const failure = new AudioProviderError(
          "frontend.audio_repeat_failed",
          `audio repeat failed for ${resource.resourceId}: ${String(error)}`,
        );
        target.failure = failure.message;
        this.reportError(failure);
        this.releaseActiveResource(target);
      });
      return;
    }
    this.releaseActiveResource(target);
  }

  private handleMediaError(target: MediaAudioTarget): void {
    const resource = target.resource;
    if (!resource?.metadataReady) return;
    const code = target.element.error?.code;
    const failure = new AudioProviderError(
      "frontend.audio_decode_failed",
      `media provider failed for ${resource.resourceId}${code ? ` (code ${code})` : ""}`,
    );
    target.failure = failure.message;
    this.reportError(failure);
    this.releaseActiveResource(target);
  }

  private cancelPendingLoad(target: MediaAudioTarget): void {
    const pending = target.pendingLoad;
    if (!pending) return;
    target.pendingLoad = undefined;
    pending.controller.abort();
    if (target.resource?.controller === pending.controller) this.releaseActiveResource(target);
  }

  private releaseTargetPlayback(target: MediaAudioTarget): void {
    this.cancelPendingLoad(target);
    this.releaseActiveResource(target);
  }

  private releaseActiveResource(target: MediaAudioTarget): void {
    const resource = target.resource;
    if (!resource) return;
    target.resource = undefined;
    resource.controller.abort();
    target.element.pause();
    target.element.removeAttribute("src");
    target.positionFloorMs = 0;
    URL.revokeObjectURL(resource.objectUrl);
    this.retainedBytes = Math.max(0, this.retainedBytes - resource.bytes);
    if (resource.started) this.observePlayback?.("ended", resource.resourceId);
  }

  private actualTargetState(target: MediaAudioTarget): {
    state: AudioPlaybackState;
    durationMs: number;
    positionMs: number;
    volumeMillionths: number;
    rateMillionths: number;
    preservePitch: boolean;
  } {
    const property = pitchProperty(target.element);
    if (!property)
      throw new AudioProviderError(
        "frontend.audio_pitch_unsupported",
        "media element exposes no preserve-pitch property",
      );
    const pitch = readPitch(target.element, property);
    if (typeof pitch !== "boolean")
      throw new AudioProviderError(
        "frontend.audio_provider_failure",
        "media element preserve-pitch state is not readable",
      );
    const volumeScale = this.outputVolumeScale();
    return {
      state: targetState(target),
      durationMs: target.resource ? milliseconds(target.element.duration) : 0,
      positionMs: providerPositionMs(target),
      volumeMillionths: providerMillionths(
        volumeScale > 0
          ? target.element.volume / volumeScale
          : target.volumeMillionths / ONE_MILLION,
        0,
        1,
        "volume",
      ),
      rateMillionths: providerMillionths(target.element.playbackRate, 0.1, 10, "rate"),
      preservePitch: pitch,
    };
  }

  private pause(target: MediaAudioTarget): void {
    this.preservePosition(target);
    target.element.pause();
  }

  private preservePosition(target: MediaAudioTarget): void {
    if (!target.resource) return;
    target.positionFloorMs = Math.max(
      target.positionFloorMs,
      milliseconds(target.element.currentTime),
    );
  }

  private teardownProvider(next: ProviderReadiness): void {
    if (this.targets) {
      for (const target of this.targets.values()) this.releaseTargetPlayback(target);
      cleanupProviderTargets(this.targets);
    }
    this.targets = undefined;
    this.retainedBytes = 0;
    const context = this.context;
    this.context = undefined;
    if (typeof context?.close === "function") void context.close().catch(this.reportError);
    this.readiness = next;
  }
}

function audioChannels(): AudioTargetChannel[] {
  return [
    ...Array.from({ length: SOUND_VOICE_COUNT }, (_, channel) => ({
      type: "sound" as const,
      channel,
    })),
    { type: "bgm" },
  ];
}

function cleanupProviderTargets(targets: Map<string, MediaAudioTarget>): void {
  clearProviderTargetHandlers(targets);
}

function clearProviderTargetHandlers(targets: Map<string, MediaAudioTarget>): void {
  for (const target of targets.values()) {
    target.element.onended = null;
    target.element.onerror = null;
  }
}

function parseServiceChannel(value: unknown): AudioTargetChannel {
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1]))
    throw new RuntimeServiceError("invalid_request", "audio channel has an invalid shape");
  if (value[0] === 1 && value[1].length === 0) return { type: "bgm" };
  if (
    value[0] === 0 &&
    value[1].length === 1 &&
    Number.isInteger(value[1][0]) &&
    Number(value[1][0]) >= 0 &&
    Number(value[1][0]) < SOUND_VOICE_COUNT
  )
    return { type: "sound", channel: Number(value[1][0]) };
  throw new RuntimeServiceError("invalid_request", "audio channel is out of range");
}

function serviceChannel(channel: AudioTargetChannel): unknown[] {
  return channel.type === "bgm" ? [1, []] : [0, [channel.channel]];
}

function targetState(target: MediaAudioTarget): AudioPlaybackState {
  if (!target.resource || target.element.ended) return "stopped";
  return target.element.paused ? "paused" : "playing";
}

function providerPositionMs(target: MediaAudioTarget): number {
  if (!target.resource) return 0;
  return Math.max(target.positionFloorMs, milliseconds(target.element.currentTime));
}

function pitchProperty(
  element: HTMLAudioElement,
): "preservesPitch" | "webkitPreservesPitch" | null {
  if ("preservesPitch" in element) return "preservesPitch";
  if ("webkitPreservesPitch" in element) return "webkitPreservesPitch";
  return null;
}

function writePitch(
  element: HTMLAudioElement,
  property: "preservesPitch" | "webkitPreservesPitch",
  value: boolean,
): void {
  (element as HTMLAudioElement & { webkitPreservesPitch?: boolean })[property] = value;
}

function readPitch(
  element: HTMLAudioElement,
  property: "preservesPitch" | "webkitPreservesPitch",
): unknown {
  return (element as HTMLAudioElement & { webkitPreservesPitch?: boolean })[property];
}

function providerMillionths(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new AudioProviderError(
      "frontend.audio_provider_failure",
      `media provider ${name} is outside its supported range`,
    );
  return Math.round(value * ONE_MILLION);
}

function milliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * 1000));
}

function monotonicTimeNanoseconds(): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() * 1_000_000)));
}

function audioMimeType(resourceId: string): string {
  const extension = resourceId.split(".").at(-1)?.toLowerCase() ?? "";
  return AUDIO_MIME_TYPES[extension] ?? "application/octet-stream";
}

function abortableResourceRead(
  read: Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) return Promise.reject(new AudioLoadCancelled());
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(new AudioLoadCancelled());
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void read.then(
      (bytes) => {
        cleanup();
        if (signal.aborted) reject(new AudioLoadCancelled());
        else resolve(bytes);
      },
      (error) => {
        cleanup();
        if (signal.aborted) reject(new AudioLoadCancelled());
        else reject(error);
      },
    );
  });
}

function waitForMetadata(
  element: HTMLAudioElement,
  signal: AbortSignal,
  timeoutMs: number,
  resourceId: string,
): Promise<void> {
  if (element.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new AudioProviderError(
          "frontend.audio_metadata_timeout",
          `media metadata timed out for ${resourceId}`,
        ),
      );
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener("loadedmetadata", loaded);
      element.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const loaded = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        new AudioProviderError(
          "frontend.audio_decode_failed",
          `audio decode failed for ${resourceId}${element.error?.code ? ` (code ${element.error.code})` : ""}`,
        ),
      );
    };
    const aborted = () => {
      cleanup();
      reject(new AudioLoadCancelled());
    };
    element.addEventListener("loadedmetadata", loaded, { once: true });
    element.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function stableAudioFailure(error: unknown): string {
  if (error instanceof AudioProviderError) return error.message;
  if (error instanceof Error && error.message.startsWith("frontend.")) return error.message;
  return `frontend.audio_provider_failure: ${String(error)}`;
}
