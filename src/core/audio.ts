import type { FrontendBridge, Preferences } from "@/core/types";

interface ActiveChannel {
  source: AudioBufferSourceNode;
  gain: GainNode;
  identity: string;
  channelId: number;
  resourceId: string;
  recoverable: boolean;
}

interface PendingChannel {
  identity: string;
  state: any;
  token: symbol;
  channelId: number;
  recoverable: boolean;
}

export type AudioPlaybackEvent = "started" | "ended";

const SOUND_CHANNEL_ID = 0;
const SOUND_VOICE_COUNT = 10;

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private readonly channels = new Map<number, ActiveChannel>();
  private readonly pending = new Map<number, PendingChannel>();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private readonly groupVolumes = new Map<number, number>();
  private effectSequence = 0;

  constructor(
    private readonly bridge: FrontendBridge,
    private preferences: Preferences,
    private readonly reportError: (error: unknown) => void = () => undefined,
    private readonly observePlayback?: (event: AudioPlaybackEvent, resourceId: string) => void,
  ) {}

  async unlock(): Promise<boolean> {
    const context = this.audioContext();
    await context.resume();
    return context.state === "running";
  }

  setPreferences(preferences: Preferences): void {
    this.preferences = preferences;
    if (this.master) this.master.gain.value = preferences.masterVolume;
  }

  synchronize(states: any[]): Promise<void> {
    const retained = new Set<number>();
    for (const state of states) {
      retained.add(state.channel_id);
      const active = this.channels.get(state.channel_id);
      const pending = this.pending.get(state.channel_id);
      const identity = `runtime:${state.revision}`;
      if (!state.playing) {
        this.stop(state.channel_id);
      } else if (!active || active.identity !== identity) {
        if (pending?.identity === identity) pending.state = state;
        else this.play(state, identity);
      } else {
        active.gain.gain.value = Number(state.volume_millionths) / 1_000_000;
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
      const identity = `effect:${++this.effectSequence}`;
      if (channelId === SOUND_CHANNEL_ID) this.playSound(state, identity);
      else this.play(state, identity);
    }
    return Promise.resolve();
  }

  close(): void {
    for (const channel of this.channels.keys()) this.stop(channel);
    this.pending.clear();
    void this.context?.close();
  }

  private audioContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.preferences.masterVolume;
      this.master.connect(this.context.destination);
    }
    return this.context;
  }

  private playSound(state: any, identity: string): void {
    let playbackId = -1;
    for (let slot = 0; slot < SOUND_VOICE_COUNT; slot += 1) {
      const candidate = -(slot + 1);
      if (!this.channels.has(candidate) && !this.pending.has(candidate)) {
        playbackId = candidate;
        break;
      }
    }
    this.play(state, identity, playbackId, false);
  }

  private play(
    state: any,
    identity: string,
    playbackId = state.channel_id,
    recoverable = true,
  ): void {
    this.stop(playbackId);
    const token = Symbol("audio playback");
    const pending = {
      identity,
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
          identity: current.identity,
          channelId: current.channelId,
          resourceId: latest.resource_id,
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

  private releaseActive(
    playbackId: number,
    source: AudioBufferSourceNode,
  ): ActiveChannel | undefined {
    const active = this.channels.get(playbackId);
    if (active?.source !== source) return undefined;
    this.channels.delete(playbackId);
    active.source.onended = null;
    active.source.disconnect();
    active.gain.disconnect();
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
    const cached = this.buffers.get(resourceId);
    if (cached) return cached;
    const promise = this.bridge.readResource(resourceId).then((bytes) => {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return this.audioContext().decodeAudioData(buffer);
    });
    this.buffers.set(resourceId, promise);
    void promise.catch(() => {
      if (this.buffers.get(resourceId) === promise) this.buffers.delete(resourceId);
    });
    return promise;
  }
}
