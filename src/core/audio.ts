import type { FrontendBridge, Preferences } from "@/core/types";
import {
  SOUND_CHANNEL_ID,
  SOUND_VOICE_COUNT,
  type ActiveAudioChannel,
  type PendingAudioChannel,
} from "@/core/audio/model";

export type AudioPlaybackEvent = "started" | "ended";

const DEFAULT_AUDIO_BUFFER_BUDGET_BYTES = 128 * 1024 * 1024;

interface AudioBufferEntry {
  readonly generation: number;
  readonly resourceId: string;
  readonly promise: Promise<AudioBuffer>;
  bytes: number;
  lastUsed: number;
}

export interface AudioMemoryCounters {
  count: number;
  estimatedBytes: number;
}

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private readonly channels = new Map<number, ActiveAudioChannel>();
  private readonly pending = new Map<number, PendingAudioChannel>();
  private readonly buffers = new Map<string, AudioBufferEntry>();
  private readonly groupVolumes = new Map<number, number>();
  private gameVolume = 1;
  private resourceGeneration = 0;
  private bufferClock = 0;

  constructor(
    private readonly bridge: FrontendBridge,
    private preferences: Preferences,
    private readonly reportError: (error: unknown) => void = () => undefined,
    private readonly observePlayback?: (event: AudioPlaybackEvent, resourceId: string) => void,
    private readonly bufferBudgetBytes = DEFAULT_AUDIO_BUFFER_BUDGET_BYTES,
  ) {}

  async unlock(): Promise<boolean> {
    const context = this.audioContext();
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

  synchronize(states: any[]): Promise<void> {
    const retained = new Set<number>();
    for (const state of states) {
      retained.add(state.channel_id);
      if (!state.playing) {
        this.stop(state.channel_id);
      } else if (!this.continuePlayback(state, state.channel_id)) {
        this.play(state);
      }
    }
    for (const [playbackId, active] of this.channels)
      if (active.recoverable && !retained.has(playbackId)) this.stop(playbackId);
    for (const [playbackId, pending] of this.pending)
      if (pending.recoverable && !retained.has(playbackId)) this.stop(playbackId);
    return Promise.resolve();
  }

  applyEffect(effect: any): Promise<void> {
    const channelId = Number(effect.channel_id);
    if (effect.action === "stop") this.stopGroup(channelId);
    else if (effect.action === "set_volume") {
      this.setGroupVolume(channelId, effect.volume_millionths);
    } else if (effect.resource_id) {
      const state = {
        ...effect,
        channel_id: channelId,
        playing: true,
        volume_millionths: this.groupVolumes.get(channelId) ?? effect.volume_millionths,
      };
      if (channelId === SOUND_CHANNEL_ID) this.playSound(state);
      else if (state.repeat_count >= 0 || !this.continuePlayback(state, channelId))
        this.play(state);
    }
    return Promise.resolve();
  }

  close(): void {
    this.resetResources(this.resourceGeneration + 1);
  }

  resetResources(generation: number): void {
    for (const channel of [...this.channels.keys()]) this.stop(channel);
    this.pending.clear();
    this.buffers.clear();
    this.groupVolumes.clear();
    this.resourceGeneration = generation;
    this.bufferClock = 0;
    const context = this.context;
    this.context = undefined;
    this.master = undefined;
    if (typeof context?.close === "function") void context.close().catch(this.reportError);
  }

  memoryCounters(): AudioMemoryCounters {
    let estimatedBytes = 0;
    for (const entry of this.buffers.values()) estimatedBytes += entry.bytes;
    return { count: this.buffers.size, estimatedBytes };
  }

  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.applyMasterVolume();
      this.master.connect(this.context.destination);
    }
    return this.context;
  }

  private applyMasterVolume(): void {
    if (this.master) this.master.gain.value = this.preferences.masterVolume * this.gameVolume;
  }

  private playSound(state: any): void {
    let playbackId = -1;
    for (let slot = 0; slot < SOUND_VOICE_COUNT; slot += 1) {
      const candidate = -(slot + 1);
      if (!this.channels.has(candidate) && !this.pending.has(candidate)) {
        playbackId = candidate;
        break;
      }
    }
    this.play(state, playbackId, false);
  }

  private play(state: any, playbackId = state.channel_id, recoverable = true): void {
    this.stop(playbackId);
    const token = Symbol("audio playback");
    const pending = {
      state,
      token,
      channelId: Number(state.channel_id),
      recoverable,
    };
    this.pending.set(playbackId, pending);
    setTimeout(() => this.loadPending(playbackId, token), 0);
  }

  private loadPending(playbackId: number, token: symbol): void {
    const scheduled = this.pending.get(playbackId);
    if (scheduled?.token !== token) return;
    void this.load(scheduled.state.resource_id)
      .then((buffer) => {
        const current = this.pending.get(playbackId);
        if (current?.token !== token) return;
        const latest = current.state;
        const context = this.audioContext();
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = latest.repeat_count < 0;
        gain.gain.value = Number(latest.volume_millionths) / 1_000_000;
        source.onended = () => {
          const ended = this.releaseActive(playbackId, source);
          if (ended) this.observePlayback?.("ended", ended.resourceId);
        };
        this.channels.set(playbackId, {
          source,
          gain,
          channelId: current.channelId,
          resourceId: latest.resource_id,
          repeatCount: Number(latest.repeat_count),
          recoverable: current.recoverable,
        });
        try {
          source.connect(gain).connect(this.master!);
          source.start();
        } catch (error) {
          this.releaseActive(playbackId, source);
          throw error;
        }
        this.pending.delete(playbackId);
        this.observePlayback?.("started", latest.resource_id);
      })
      .catch((error) => {
        if (this.pending.get(playbackId)?.token !== token) return;
        this.pending.delete(playbackId);
        this.evictBuffers();
        this.reportError(error);
      });
  }

  private stop(playbackId: number): void {
    this.pending.delete(playbackId);
    const active = this.channels.get(playbackId);
    if (!active) return;
    active.source.onended = null;
    try {
      active.source.stop();
    } finally {
      this.releaseActive(playbackId, active.source);
      this.observePlayback?.("ended", active.resourceId);
    }
  }

  private continuePlayback(state: any, playbackId: number): boolean {
    const active = this.channels.get(playbackId);
    if (active && this.matches(active.resourceId, active.repeatCount, state)) {
      active.gain.gain.value = Number(state.volume_millionths) / 1_000_000;
      return true;
    }
    const pending = this.pending.get(playbackId);
    if (!pending || !this.matches(pending.state.resource_id, pending.state.repeat_count, state))
      return false;
    pending.state = state;
    return true;
  }

  private matches(resourceId: unknown, repeatCount: unknown, state: any): boolean {
    return resourceId === state.resource_id && Number(repeatCount) === Number(state.repeat_count);
  }

  private releaseActive(
    playbackId: number,
    source: AudioBufferSourceNode,
  ): ActiveAudioChannel | undefined {
    const active = this.channels.get(playbackId);
    if (active?.source !== source) return undefined;
    this.channels.delete(playbackId);
    active.source.onended = null;
    active.source.disconnect();
    active.gain.disconnect();
    this.evictBuffers();
    return active;
  }

  private stopGroup(channelId: number): void {
    for (const [playbackId, active] of this.channels)
      if (active.channelId === channelId) this.stop(playbackId);
    for (const [playbackId, pending] of this.pending)
      if (pending.channelId === channelId) this.stop(playbackId);
  }

  private setGroupVolume(channelId: number, volumeMillionths: number): void {
    this.groupVolumes.set(channelId, Number(volumeMillionths));
    const volume = Number(volumeMillionths) / 1_000_000;
    for (const active of this.channels.values())
      if (active.channelId === channelId) active.gain.gain.value = volume;
    for (const pending of this.pending.values())
      if (pending.channelId === channelId)
        pending.state = { ...pending.state, volume_millionths: volumeMillionths };
  }

  private load(resourceId: string): Promise<AudioBuffer> {
    const generation = this.resourceGeneration;
    const key = this.bufferKey(resourceId, generation);
    const cached = this.buffers.get(key);
    if (cached) {
      cached.lastUsed = ++this.bufferClock;
      return cached.promise;
    }
    const promise = this.bridge.readResource(resourceId).then((bytes) => {
      if (generation !== this.resourceGeneration) throw new Error("音频资源 generation 已失效");
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return this.audioContext().decodeAudioData(buffer);
    });
    const entry: AudioBufferEntry = {
      generation,
      resourceId,
      promise,
      bytes: 0,
      lastUsed: ++this.bufferClock,
    };
    this.buffers.set(key, entry);
    void promise.then(
      (buffer) => {
        if (this.buffers.get(key) !== entry) return;
        entry.bytes = estimatedAudioBufferBytes(buffer);
        entry.lastUsed = ++this.bufferClock;
        this.evictBuffers();
      },
      () => {
        if (this.buffers.get(key) === entry) this.buffers.delete(key);
      },
    );
    return promise;
  }

  private bufferKey(resourceId: string, generation = this.resourceGeneration): string {
    return `${generation}\0${resourceId}`;
  }

  private evictBuffers(): void {
    let total = this.memoryCounters().estimatedBytes;
    if (total <= this.bufferBudgetBytes) return;
    const retained = new Set<string>();
    for (const active of this.channels.values()) retained.add(this.bufferKey(active.resourceId));
    for (const pending of this.pending.values())
      retained.add(this.bufferKey(String(pending.state.resource_id)));
    const candidates = [...this.buffers.entries()]
      .filter(([key, entry]) => entry.bytes > 0 && !retained.has(key))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key, entry] of candidates) {
      if (total <= this.bufferBudgetBytes) break;
      if (!this.buffers.delete(key)) continue;
      total -= entry.bytes;
    }
  }
}

function estimatedAudioBufferBytes(buffer: AudioBuffer): number {
  const frames = Number(buffer.length);
  const channels = Number(buffer.numberOfChannels);
  if (!Number.isFinite(frames) || !Number.isFinite(channels) || frames < 0 || channels < 0)
    return 0;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(frames * channels * Float32Array.BYTES_PER_ELEMENT),
  );
}
