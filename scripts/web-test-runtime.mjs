export function terminalRuntimeRejection(snapshot) {
  return snapshot?.logs?.find((entry) =>
    /command rejected \[(?:VersionMismatch|ProtocolMismatch)\]/.test(String(entry?.message)),
  );
}

export function runtimeProgressSignature(snapshot) {
  return JSON.stringify({
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait
      ? {
          kind: snapshot.wait.kind,
          wait_id: snapshot.wait.wait_id,
          generation: snapshot.wait.generation,
        }
      : null,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-2),
    lastLog: snapshot?.logs?.at(-1),
  });
}

export function runtimeProgressDiagnostic(snapshot) {
  return {
    phase: snapshot?.phase,
    status: snapshot?.status,
    projectOpen: snapshot?.projectOpen,
    canInteract: snapshot?.canInteract,
    wait: snapshot?.wait,
    presentationRevision: snapshot?.presentationRevision,
    outputTail: snapshot?.output?.slice(-12),
    fault: snapshot?.fault,
    logTail: snapshot?.logs?.slice(-8),
  };
}

export function observationFromSnapshot(snapshot, previous = []) {
  const output = snapshot.output ?? [];
  let common = 0;
  while (common < previous.length && common < output.length && previous[common] === output[common])
    common += 1;
  return {
    termination: snapshot.fault
      ? "faulted"
      : snapshot.phase === "waiting_input"
        ? "waitingInput"
        : snapshot.phase,
    phase: snapshot.phase,
    wait: snapshot.wait,
    output,
    output_delta: {
      reset: common === 0 && previous.length > 0,
      removed: previous.length - common,
      added: output.slice(common),
    },
    output_tail: output.slice(-30),
    statuses: [snapshot.status],
    fault: snapshot.fault,
    frontend: snapshot,
  };
}

export function goalStatus(observation, goal) {
  const checks = {};
  const output = observation.output.join("\n");
  for (const value of goal.output_contains ?? [])
    checks[`output_contains:${value}`] = output.includes(String(value));
  if (goal.wait_kind != null) checks.wait_kind = observation.wait?.kind === goal.wait_kind;
  if (goal.termination != null) checks.termination = observation.termination === goal.termination;
  for (const value of goal.status_contains ?? [])
    checks[`status_contains:${value}`] = observation.statuses.some((item) =>
      item.includes(String(value)),
    );
  for (const [name, value] of Object.entries(goal.watch_equals ?? {}))
    checks[`watch_equals:${name}`] = observation.watches?.[name] === value;
  if (goal.line_count_lte != null)
    checks.line_count_lte = observation.output.length <= goal.line_count_lte;
  if (goal.snake_audio_relations === true) Object.assign(checks, snakeAudioRelations(observation));
  if (goal.snake_audio_stress_relations === true)
    Object.assign(checks, snakeAudioStressRelations(observation));
  return {
    satisfied: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean),
    checks,
  };
}

export function snakeAudioRelations(observation) {
  const output = (observation.output ?? []).join("\n");
  const values = (prefix) => {
    const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
    if (!line) return {};
    return Object.fromEntries(
      [...line.matchAll(/(?:^|,)([a-z0-9_]+)=(-?\d+)/gi)].map((match) => [
        match[1],
        Number(match[2]),
      ]),
    );
  };
  const play = values("playing=");
  const omitted = values("omitted=");
  const paused = values("paused_is=");
  const resumed = values("resumed_is=");
  const rate = values("rate_omitted=");
  const allBusy = values("all_busy_overwrite_0_duration=");
  const pausedReuse = values("paused_reused_3_duration=");
  const natural = values("short_natural_state=");
  const bgmPlay = values("bgm_playing=");
  const bgmPause = values("bgm_paused=");
  const bgmRate = values("bgm_rate_omitted=");
  const provider = observation.frontend?.audioProvider ?? {};
  const playback = observation.frontend?.audioPlayback ?? {};
  const audioBuffers = observation.frontend?.memory?.audioBuffers;
  const logs = observation.frontend?.logs ?? [];
  return {
    "snake_audio:sound_duration": play.sound_play_duration === 5_000,
    "snake_audio:playing_position": play.playing === 0 && play.sound_play_position > 0,
    "snake_audio:volume": play.volume === 37,
    "snake_audio:omitted_selector":
      omitted.omitted === omitted.r0 &&
      omitted.r0 === 5_000 &&
      omitted.r1 >= play.sound_play_position &&
      omitted.r2 === 1 &&
      omitted.r3 === 37 &&
      omitted.r4 === 100,
    "snake_audio:pause_stable":
      paused.paused_is === -1 && Math.abs(paused.pause_pos_b - paused.pause_pos_a) <= 50,
    "snake_audio:resume_continues":
      resumed.resumed_is === 0 && resumed.resume_pos > paused.pause_pos_b,
    "snake_audio:rate_pitch":
      rate.rate_omitted === 1 &&
      rate.speed === 250 &&
      rate.pitch_zero === 1 &&
      rate.pitch_nonzero === 1,
    "snake_audio:all_busy_overwrite_zero": allBusy.all_busy_overwrite_0_duration === 750,
    "snake_audio:paused_reuse_three": pausedReuse.paused_reused_3_duration === 750,
    "snake_audio:natural_release":
      natural.short_natural_state === -1 && natural.duration === 0 && natural.position === 0,
    "snake_audio:bgm_duration": bgmPlay.bgm_playing === 1 && bgmPlay.bgm_duration === 5_000,
    "snake_audio:bgm_pause_stable":
      bgmPause.bgm_paused === 0 && Math.abs(bgmPause.pos_b - bgmPause.pos_a) <= 50,
    "snake_audio:bgm_rate_pitch":
      bgmRate.bgm_rate_omitted === 1 &&
      bgmRate.bgm_pitch_zero === 1 &&
      bgmRate.bgm_pitch_nonzero === 1 &&
      bgmRate.bgm_resumed === 1 &&
      bgmRate.bgm_speed === 250,
    "snake_audio:decode_failure":
      output.includes("corrupt_decode_continued=1") &&
      logs.some((entry) => String(entry?.message).includes("frontend.audio_decode_failed")),
    "snake_audio:actual_pitch_property":
      output.includes("final_pitch_nonzero=1") &&
      provider["sound:0"]?.rateMillionths === 2_500_000 &&
      provider["sound:0"]?.preservePitch === false,
    "snake_audio:provider_released":
      audioBuffers?.count === 0 &&
      audioBuffers?.estimatedBytes === 0 &&
      Object.keys(provider).length === 11 &&
      Object.values(provider).every(
        (target) =>
          target?.resourceId == null &&
          target?.pending === false &&
          target?.state === "stopped" &&
          target?.failure == null &&
          BigInt(target?.revision ?? 0) > 0n,
      ),
    "snake_audio:playback_released": Object.values(playback).every((entry) => entry?.active === 0),
  };
}

export function snakeAudioStressRelations(observation) {
  const output = (observation.output ?? []).join("\n");
  const provider = observation.frontend?.audioProvider ?? {};
  const playback = observation.frontend?.audioPlayback ?? {};
  const audioBuffers = observation.frontend?.memory?.audioBuffers;
  const logs = observation.frontend?.logs ?? [];
  const releasedTargets =
    Object.keys(provider).length === 11 &&
    Object.values(provider).every(
      (target) =>
        target?.resourceId == null &&
        target?.pending === false &&
        target?.state === "stopped" &&
        target?.failure == null &&
        BigInt(target?.revision ?? 0) > 0n,
    );
  return {
    "snake_audio_stress:ten_channels": output.includes("stress_channels=0,1,2,3,4,5,6,7,8,9"),
    "snake_audio_stress:overwrite_zero": output.includes("stress_overwrite_duration=750"),
    "snake_audio_stress:bgm": output.includes("stress_bgm=1,duration=5000"),
    "snake_audio_stress:decode_failure": logs.some((entry) =>
      String(entry?.message).includes("frontend.audio_decode_failed"),
    ),
    "snake_audio_stress:provider_released":
      releasedTargets && audioBuffers?.count === 0 && audioBuffers?.estimatedBytes === 0,
    "snake_audio_stress:playback_counts":
      playback["sound/batch5-long.wav"]?.starts === 11 &&
      playback["sound/batch5-short.wav"]?.starts === 1,
    "snake_audio_stress:playback_released": Object.values(playback).every(
      (entry) => entry?.active === 0,
    ),
  };
}
