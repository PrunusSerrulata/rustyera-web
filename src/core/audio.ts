import type { FrontendBridge, Preferences } from "@/core/types";

interface ActiveChannel {
  source: AudioBufferSourceNode;
  gain: GainNode;
  identity: string;
}

interface PendingChannel {
  identity: string;
  state: any;
  token: symbol;
}

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private readonly channels = new Map<number, ActiveChannel>();
  private readonly pending = new Map<number, PendingChannel>();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private effectSequence = 0;

  constructor(
    private readonly bridge: FrontendBridge,
    private preferences: Preferences,
    private readonly reportError: (error: unknown) => void = () => undefined,
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
    for (const channel of this.channels.keys()) if (!retained.has(channel)) this.stop(channel);
    for (const channel of this.pending.keys()) if (!retained.has(channel)) this.stop(channel);
    return Promise.resolve();
  }

  applyEffect(effect: any): Promise<void> {
    if (effect.action === "stop") this.stop(effect.channel_id);
    else if (effect.action === "set_volume") {
      const active = this.channels.get(effect.channel_id);
      if (active) active.gain.gain.value = Number(effect.volume_millionths) / 1_000_000;
      const pending = this.pending.get(effect.channel_id);
      if (pending)
        pending.state = { ...pending.state, volume_millionths: effect.volume_millionths };
    } else if (effect.resource_id) {
      this.play({ ...effect, playing: true }, `effect:${++this.effectSequence}`);
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

  private play(state: any, identity: string): void {
    this.stop(state.channel_id);
    const token = Symbol("audio playback");
    const pending = { identity, state, token };
    this.pending.set(state.channel_id, pending);
    setTimeout(() => this.loadPending(state.channel_id, token), 0);
  }

  private loadPending(channelId: number, token: symbol): void {
    const scheduled = this.pending.get(channelId);
    if (scheduled?.token !== token) return;
    void this.load(scheduled.state.resource_id)
      .then((buffer) => {
        const current = this.pending.get(channelId);
        if (current?.token !== token) return;
        const latest = current.state;
        const context = this.audioContext();
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = latest.repeat_count < 0;
        gain.gain.value = Number(latest.volume_millionths) / 1_000_000;
        source.connect(gain).connect(this.master!);
        source.start();
        source.onended = () => {
          if (this.channels.get(latest.channel_id)?.source === source)
            this.channels.delete(latest.channel_id);
        };
        this.pending.delete(latest.channel_id);
        this.channels.set(latest.channel_id, {
          source,
          gain,
          identity: current.identity,
        });
      })
      .catch((error) => {
        if (this.pending.get(channelId)?.token !== token) return;
        this.pending.delete(channelId);
        this.reportError(error);
      });
  }

  private stop(channelId: number): void {
    this.pending.delete(channelId);
    const active = this.channels.get(channelId);
    if (!active) return;
    active.source.onended = null;
    active.source.stop();
    active.source.disconnect();
    active.gain.disconnect();
    this.channels.delete(channelId);
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
