export interface ActiveAudioChannel {
  source: AudioBufferSourceNode;
  gain: GainNode;
  channelId: number;
  resourceId: string;
  repeatCount: number;
  recoverable: boolean;
}

export interface PendingAudioChannel {
  state: any;
  token: symbol;
  channelId: number;
  recoverable: boolean;
}

export const SOUND_CHANNEL_ID = 0;
export const SOUND_VOICE_COUNT = 10;
