import { serviceInteger, type ServiceInteger } from "@/core/runtimeServiceProtocol";

export type AudioTargetChannel = { type: "sound"; channel: number } | { type: "bgm" };

export type AudioPlaybackState = "stopped" | "playing" | "paused";

interface AudioProjectionBase {
  channel: AudioTargetChannel;
  revision: ServiceInteger;
  volumeMillionths: number;
  rateMillionths: number;
  preservePitch: boolean;
}

export interface AudioStateProjection extends AudioProjectionBase {
  resourceId: string;
  repeatCount: number;
  state: AudioPlaybackState;
}

export type AudioEffectProjection =
  | (AudioProjectionBase & {
      action: "play";
      resourceId: string;
      repeatCount: number;
    })
  | (AudioProjectionBase & {
      action: "stop" | "set_volume" | "pause" | "resume" | "set_rate";
      resourceId: null;
      repeatCount: 0;
    });

export interface PendingAudioLoad {
  revision: ServiceInteger;
  generation: number;
  resourceId: string;
  controller: AbortController;
}

export interface AudioTargetResource {
  resourceId: string;
  objectUrl: string;
  bytes: number;
  remainingPlays: number;
  started: boolean;
  metadataReady: boolean;
  controller: AbortController;
}

export interface MediaAudioTarget {
  channel: AudioTargetChannel;
  element: HTMLAudioElement;
  revision: ServiceInteger;
  volumeMillionths: number;
  rateMillionths: number;
  preservePitch: boolean;
  positionFloorMs: number;
  pendingLoad?: PendingAudioLoad;
  resource?: AudioTargetResource;
  failure?: string;
}

export const SOUND_VOICE_COUNT = 10;
const ONE_MILLION = 1_000_000;

export function audioTargetKey(channel: AudioTargetChannel): string {
  return channel.type === "bgm" ? "bgm" : `sound:${channel.channel}`;
}

export function parseAudioStates(value: unknown): AudioStateProjection[] {
  if (!Array.isArray(value)) throw invalidAudioState("audio state must be an array");
  const states = value.map(parseAudioState);
  const targets = new Set<string>();
  for (const state of states) {
    const key = audioTargetKey(state.channel);
    if (targets.has(key)) throw invalidAudioState(`audio target ${key} is duplicated`);
    targets.add(key);
  }
  return states;
}

export function parseAudioState(value: unknown): AudioStateProjection {
  const fields = audioRecord(value, "audio state", "state");
  return {
    channel: parseAudioChannel(fields.channel, "state"),
    resourceId: requiredResourceId(fields.resource_id, "state"),
    repeatCount: repeatCount(fields.repeat_count, "state"),
    volumeMillionths: boundedMillionths(
      fields.volume_millionths,
      "audio state volume",
      0,
      ONE_MILLION,
      "state",
    ),
    state: playbackState(fields.state),
    revision: projectionRevision(fields.revision, "audio state revision", "state"),
    rateMillionths: boundedMillionths(
      fields.rate_millionths,
      "audio state rate",
      100_000,
      10_000_000,
      "state",
    ),
    preservePitch: requiredBoolean(fields.preserve_pitch, "audio state preserve-pitch", "state"),
  };
}

export function parseAudioEffect(value: unknown): AudioEffectProjection {
  const fields = audioRecord(value, "audio effect", "effect");
  const action = effectAction(fields.action);
  const common: AudioProjectionBase = {
    channel: parseAudioChannel(fields.channel, "effect"),
    revision: projectionRevision(fields.revision, "audio effect revision", "effect"),
    volumeMillionths: boundedMillionths(
      fields.volume_millionths,
      "audio effect volume",
      0,
      ONE_MILLION,
      "effect",
    ),
    rateMillionths: boundedMillionths(
      fields.rate_millionths,
      "audio effect rate",
      100_000,
      10_000_000,
      "effect",
    ),
    preservePitch: requiredBoolean(fields.preserve_pitch, "audio effect preserve-pitch", "effect"),
  };
  if (action === "play") {
    return {
      ...common,
      action,
      resourceId: requiredResourceId(fields.resource_id, "effect"),
      repeatCount: repeatCount(fields.repeat_count, "effect"),
    };
  }
  if (fields.resource_id != null || !isZeroEffectRepeatCount(fields.repeat_count))
    throw invalidAudioEffect(`${action} must not carry a resource or repeat count`);
  return { ...common, action, resourceId: null, repeatCount: 0 };
}

function audioRecord(
  value: unknown,
  name: string,
  kind: "state" | "effect",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidAudio(kind, `${name} is not an object`);
  return value as Record<string, unknown>;
}

function parseAudioChannel(value: unknown, kind: "state" | "effect"): AudioTargetChannel {
  if (!value || typeof value !== "object") throw invalidAudio(kind, "audio channel is missing");
  const channel = value as { type?: unknown; channel?: unknown };
  if (channel.type === "bgm" && channel.channel == null) return { type: "bgm" };
  if (channel.type === "sound") {
    try {
      const number = serviceInteger(channel.channel, "audio sound channel");
      if (BigInt(number) < BigInt(SOUND_VOICE_COUNT))
        return { type: "sound", channel: Number(number) };
    } catch {
      // Report every malformed or out-of-range representation through the projection category.
    }
  }
  throw invalidAudio(kind, "audio channel is out of range");
}

function isZeroEffectRepeatCount(value: unknown): boolean {
  try {
    return BigInt(serviceInteger(value, "audio effect repeat count", true)) === 0n;
  } catch {
    throw invalidAudioEffect("audio effect repeat count is invalid");
  }
}

function playbackState(value: unknown): AudioPlaybackState {
  if (value === "stopped" || value === "playing" || value === "paused") return value;
  throw invalidAudioState("audio playback state is invalid");
}

function effectAction(value: unknown): AudioEffectProjection["action"] {
  if (
    value === "play" ||
    value === "stop" ||
    value === "set_volume" ||
    value === "pause" ||
    value === "resume" ||
    value === "set_rate"
  )
    return value;
  throw invalidAudioEffect(`unsupported audio action ${String(value)}`);
}

function requiredResourceId(value: unknown, kind: "state" | "effect"): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidAudio(kind, "audio resource ID is missing");
}

function repeatCount(value: unknown, kind: "state" | "effect"): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count === 0 || count < -1)
    throw invalidAudio(kind, "audio repeat count is invalid");
  return count;
}

function boundedMillionths(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  kind: "state" | "effect",
): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum)
    throw invalidAudio(kind, `${name} is out of range`);
  return amount;
}

function requiredBoolean(value: unknown, name: string, kind: "state" | "effect"): boolean {
  if (typeof value === "boolean") return value;
  throw invalidAudio(kind, `${name} is not boolean`);
}

function projectionRevision(
  value: unknown,
  name: string,
  kind: "state" | "effect",
): ServiceInteger {
  try {
    return serviceInteger(value, name);
  } catch {
    throw invalidAudio(kind, `${name} is not an unsigned 64-bit integer`);
  }
}

function invalidAudio(kind: "state" | "effect", message: string): Error {
  return kind === "state" ? invalidAudioState(message) : invalidAudioEffect(message);
}

function invalidAudioState(message: string): Error {
  return new Error(`frontend.invalid_audio_state: ${message}`);
}

function invalidAudioEffect(message: string): Error {
  return new Error(`frontend.invalid_audio_effect: ${message}`);
}
