import type { FrontendBridge, Preferences } from "@/core/types";

interface ActiveChannel {
  source: AudioBufferSourceNode;
  gain: GainNode;
  revision: number;
}

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private readonly channels = new Map<number, ActiveChannel>();
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();

  constructor(
    private readonly bridge: FrontendBridge,
    private preferences: Preferences,
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

  async synchronize(states: any[]): Promise<void> {
    const retained = new Set<number>();
    for (const state of states) {
      retained.add(state.channel_id);
      const active = this.channels.get(state.channel_id);
      if (!state.playing) {
        this.stop(state.channel_id);
      } else if (!active || active.revision !== state.revision) {
        await this.play(state);
      } else {
        active.gain.gain.value = Number(state.volume_millionths) / 1_000_000;
      }
    }
    for (const channel of this.channels.keys()) if (!retained.has(channel)) this.stop(channel);
  }

  async applyEffect(effect: any): Promise<void> {
    if (effect.type !== "audio") return;
    if (effect.value.action === "stop") this.stop(effect.value.channel_id);
    else if (effect.value.action === "set_volume") {
      const active = this.channels.get(effect.value.channel_id);
      if (active) active.gain.gain.value = Number(effect.value.volume_millionths) / 1_000_000;
    } else if (effect.value.resource_id) {
      await this.play({ ...effect.value, playing: true, revision: Date.now() });
    }
  }

  close(): void {
    for (const channel of this.channels.keys()) this.stop(channel);
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

  private async play(state: any): Promise<void> {
    this.stop(state.channel_id);
    const context = this.audioContext();
    const buffer = await this.load(state.resource_id);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = state.repeat_count < 0;
    gain.gain.value = Number(state.volume_millionths) / 1_000_000;
    source.connect(gain).connect(this.master!);
    source.start();
    source.onended = () => {
      if (this.channels.get(state.channel_id)?.source === source)
        this.channels.delete(state.channel_id);
    };
    this.channels.set(state.channel_id, { source, gain, revision: state.revision });
  }

  private stop(channelId: number): void {
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
    return promise;
  }
}
