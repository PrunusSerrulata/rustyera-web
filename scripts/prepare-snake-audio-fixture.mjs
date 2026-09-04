import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_SAMPLE_RATE = 48_000;
const source = path.resolve(
  repository,
  "../rustyera-core/tools/runtime-tester/fixture-snake-batch5-save-audio-oracle",
);
const testRuns = path.join(repository, ".rustyera", "test-runs");
const output = path.resolve(
  repository,
  process.argv[2] ?? path.join(testRuns, "snake-audio-provider"),
);
const stage = process.argv[3] ?? "full";
const stages = new Set([
  "full",
  "cache",
  "single",
  "pause",
  "resume",
  "rate-input",
  "rate-pause",
  "rate",
  "queries",
  "query-basic",
  "rate-low",
  "rate-high",
  "channels",
  "natural",
  "errors",
  "bgm",
  "controls",
  "stress",
]);
if (!stages.has(stage))
  throw new Error(`audio fixture stage must be one of ${[...stages].join(", ")}`);

await mkdir(testRuns, { recursive: true });
const relativeOutput = path.relative(testRuns, output);
if (
  !relativeOutput ||
  relativeOutput.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativeOutput)
)
  throw new Error(`audio fixture output must be a child of ${testRuns}`);
await mkdir(path.dirname(output), { recursive: true });
const [testRunsReal, parentReal] = await Promise.all([
  realpath(testRuns),
  realpath(path.dirname(output)),
]);
if (!isChildPath(testRunsReal, parentReal))
  throw new Error("audio fixture output parent escapes .rustyera/test-runs through a symlink");
try {
  const existing = await lstat(output);
  if (existing.isSymbolicLink()) throw new Error("refusing to replace a symlinked audio fixture");
  const outputReal = await realpath(output);
  if (!isChildPath(testRunsReal, outputReal))
    throw new Error("existing audio fixture escapes .rustyera/test-runs");
  await rm(output, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await cp(source, output, { recursive: true });
await writeFile(
  path.join(output, "reraconfig.toml"),
  `[meta]\nschema_version = 4\n\n[compatibility]\nprofile = "emuera.skia.snake"\n\n[save]\nbinary_format = true\n`,
);

const entryPath = path.join(output, "erb", "batch5.erb");
const entry = await readFile(entryPath, "utf8");
await writeFile(
  entryPath,
  replaceExactlyOnce(
    entry,
    /@SYSTEM_TITLE[\s\S]*?(?=@SYSTEM_LOADEND)/,
    "@SYSTEM_TITLE\nCALL B5_GUI_AUDIO\nRETURN\n\n",
    "SYSTEM_TITLE entry",
  ),
);
const audioPath = path.join(output, "erb", "gui_audio.erb");
const audio = await readFile(audioPath, "utf8");
const preparedAudio = stage === "full" ? prepareFullAudio(audio) : stagedAudio(stage);
await writeFile(audioPath, preparedAudio);
await writeFile(path.join(output, "audio-stage.json"), `${JSON.stringify({ stage })}\n`);

await mkdir(path.join(output, "sound"), { recursive: true });
await writeFile(path.join(output, "sound", "batch5-long.wav"), pcmWave(5_000, 220));
await writeFile(path.join(output, "sound", "batch5-short.wav"), pcmWave(750, 440));
await writeFile(path.join(output, "sound", "batch5-audible.wav"), pcmWave(2_000, 440, 12_000));
await writeFile(path.join(output, "sound", "batch5-audible-long.wav"), pcmWave(8_000, 440, 12_000));
await writeFile(
  path.join(output, "sound", "batch5-audible-rate.wav"),
  pcmWave(30_000, 440, 12_000),
);
await writeFile(path.join(output, "sound", "batch5-corrupt.wav"), "not a wave file");
console.log(
  JSON.stringify({
    source,
    output,
    stage,
    sampleRate: TEST_AUDIO_SAMPLE_RATE,
    generatedAudio: [
      "batch5-long.wav",
      "batch5-short.wav",
      "batch5-audible.wav",
      "batch5-audible-long.wav",
      "batch5-audible-rate.wav",
      "batch5-corrupt.wav",
    ],
  }),
);

function prepareFullAudio(audio) {
  let prepared = replaceExactlyOnce(
    audio,
    'B5_REPORT += UNICODE(13) + UNICODE(10) + "paused_reused_3_duration=" + TOSTR(GETSOUNDORBGMINFO(3, 1))',
    'B5_REPORT += UNICODE(13) + UNICODE(10) + "paused_reused_3_duration=" + TOSTR(GETSOUNDORBGMINFO(3, 1))\nAWAIT 2500\nB5_REPORT += UNICODE(13) + UNICODE(10) + "short_natural_state=" + TOSTR(ISPLAYINGSOUND(3)) + ",duration=" + TOSTR(GETSOUNDORBGMINFO(3, 1)) + ",position=" + TOSTR(GETSOUNDORBGMINFO(3, 2))\nPLAYSOUND "batch5-corrupt.wav", 1\nAWAIT 100\nB5_REPORT += UNICODE(13) + UNICODE(10) + "corrupt_decode_continued=1"\nB5_DUMMY = SOUNDCONTROL(0, 3, 250, 1)\nB5_REPORT += UNICODE(13) + UNICODE(10) + "final_pitch_nonzero=" + TOSTR(B5_DUMMY)',
    "short-audio natural completion anchor",
  );
  prepared = replaceExactlyOnce(
    prepared,
    'RESULT = SAVETEXT(B5_REPORT, "batch5-gui-result.txt", 0, 1)',
    'STOPSOUND\nAWAIT 50\nRESULT = SAVETEXT(B5_REPORT, "batch5-gui-result.txt", 0, 1)',
    "final sound release anchor",
  );
  prepared = replaceExactlyOnce(
    prepared,
    "PRINTFORML gui_write_ret={RESULT}",
    "PRINTVL B5_REPORT\nPRINTFORML gui_write_ret={RESULT}",
    "GUI report output anchor",
  );
  return replaceExactlyOnce(
    prepared,
    "PRINTL BATCH5_GUI_DONE\nAWAIT 4500\nFORCE_QUIT",
    "PRINTL BATCH5_GUI_DONE\n$B5_GUI_HOLD\nWAIT\nGOTO B5_GUI_HOLD",
    "GUI completion hold anchor",
  );
}

function stagedAudio(stage) {
  const scripts = {
    cache: `@B5_GUI_AUDIO
PRINTL BATCH5_CACHE_READY
$B5_CACHE_HOLD
WAIT
GOTO B5_CACHE_HOLD
`,
    single: `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_SINGLE_BEFORE_PLAY
PLAYSOUND "batch5-audible.wav", 1
PRINTL BATCH5_SINGLE_PLAY_RETURNED
AWAIT 1200
PRINTFORML single_playing={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},position={GETSOUNDORBGMINFO(0, 2)},volume={GETSOUNDORBGMINFO(0, 4)}
STOPSOUND
PRINTL BATCH5_SINGLE_DONE
$B5_SINGLE_HOLD
WAIT
GOTO B5_SINGLE_HOLD
`,
    pause: `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_PAUSE_BEFORE_PLAY
PLAYSOUND "batch5-audible.wav", 1
PRINTL BATCH5_PAUSE_PLAY_RETURNED
AWAIT 1200
PRINTL BATCH5_PAUSE_BEFORE_CONTROL
PRINTFORML pause_ret={SOUNDCONTROL(0, 0)}
PRINTL BATCH5_PAUSE_CONTROL_RETURNED
WAIT
PRINTFORML pause_state={ISPLAYINGSOUND(0)},position={GETSOUNDORBGMINFO(0, 2)}
STOPSOUND
PRINTL BATCH5_PAUSE_DONE
$B5_PAUSE_HOLD
WAIT
GOTO B5_PAUSE_HOLD
`,
    resume: `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_RESUME_BEFORE_PLAY
PLAYSOUND "batch5-audible-long.wav", 1
PRINTL BATCH5_RESUME_PLAY_RETURNED
AWAIT 1200
PRINTFORML resume_pause_ret={SOUNDCONTROL(0, 0)}
PRINTL BATCH5_RESUME_PAUSED
WAIT
PRINTFORML resume_ret={SOUNDCONTROL(0, 1)}
PRINTL BATCH5_RESUME_CONTROL_RETURNED
PRINTFORML resume_state={ISPLAYINGSOUND(0)},position={GETSOUNDORBGMINFO(0, 2)}
PRINTL BATCH5_RESUME_PLAYING_WAIT
WAIT
STOPSOUND
PRINTL BATCH5_RESUME_DONE
$B5_RESUME_HOLD
WAIT
GOTO B5_RESUME_HOLD
`,
    "rate-input": `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_RATE_INPUT_BEFORE_PLAY
PLAYSOUND "batch5-audible-rate.wav", 1
PRINTL BATCH5_RATE_INPUT_PLAY_RETURNED
AWAIT 1200
PRINTFORML rate_input_ret={SOUNDCONTROL(0, 3, 250, 1)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTL BATCH5_RATE_INPUT_WAIT
WAIT
PRINTL BATCH5_RATE_INPUT_RETURNED
$B5_RATE_INPUT_HOLD
WAIT
GOTO B5_RATE_INPUT_HOLD
`,
    "rate-pause": `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_RATE_PAUSE_BEFORE_PLAY
PLAYSOUND "batch5-audible-rate.wav", 1
PRINTL BATCH5_RATE_PAUSE_PLAY_RETURNED
AWAIT 1200
PRINTFORML rate_pause_rate_ret={SOUNDCONTROL(0, 3, 250, 1)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTL BATCH5_RATE_PAUSE_WAIT
WAIT
PRINTL BATCH5_RATE_PAUSE_BEFORE_CONTROL
PRINTFORML rate_pause_ret={SOUNDCONTROL(0, 0)}
PRINTL BATCH5_RATE_PAUSE_RETURNED
$B5_RATE_PAUSE_HOLD
WAIT
GOTO B5_RATE_PAUSE_HOLD
`,
    rate: `@B5_GUI_AUDIO
SETSOUNDVOLUME 100
PRINTL BATCH5_RATE_BEFORE_PLAY
PLAYSOUND "batch5-audible-rate.wav", 1
PRINTL BATCH5_RATE_PLAY_RETURNED
AWAIT 1200
PRINTFORML rate_before_position={GETSOUNDORBGMINFO(0, 2)}
PRINTFORML rate_ret={SOUNDCONTROL(0, 3, 250, 1)}
PRINTFORML rate_state={ISPLAYINGSOUND(0)},position={GETSOUNDORBGMINFO(0, 2)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTL BATCH5_RATE_PLAYING_WAIT
WAIT
PRINTL BATCH5_RATE_BEFORE_STOP
PRINTFORML rate_stop_ret={SOUNDCONTROL(0, 2)}
PRINTL BATCH5_RATE_STOP_RETURNED
PRINTL BATCH5_RATE_DONE
$B5_RATE_HOLD
WAIT
GOTO B5_RATE_HOLD
`,
    queries: `@B5_GUI_AUDIO
PRINTFORML query_invalid={GETSOUNDORBGMINFO(-2)},{ISPLAYINGSOUND(-1)},{SOUNDCONTROL(-1, 0)},action={SOUNDCONTROL(0, 9)}
SETSOUNDVOLUME 37
PLAYSOUND "batch5-long.wav", 3
AWAIT 300
PRINTFORML query_playing={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},volume={GETSOUNDORBGMINFO(0, 4)}
B5_DUMMY = GETSOUNDORBGMINFO(0)
PRINTFORML query_omitted={B5_DUMMY},r0={RESULT:0},r1={RESULT:1},r2={RESULT:2},r3={RESULT:3},r4={RESULT:4}
PRINTFORML query_rate={SOUNDCONTROL(0, 3, 250)},speed={GETSOUNDORBGMINFO(0, 5)},pitch0={SOUNDCONTROL(0, 3, 250, 0)},pitch1={SOUNDCONTROL(0, 3, 250, 1)}
B5_DUMMY = SOUNDCONTROL(0, 3, 1)
PRINTFORML query_speed_low={GETSOUNDORBGMINFO(0, 5)}
B5_DUMMY = SOUNDCONTROL(0, 3, 2000)
PRINTFORML query_speed_high={GETSOUNDORBGMINFO(0, 5)}
PRINTFORML query_stop={SOUNDCONTROL(0, 2)},state={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},position={GETSOUNDORBGMINFO(0, 2)}
PRINTL BATCH5_QUERIES_DONE
$B5_QUERIES_HOLD
WAIT
GOTO B5_QUERIES_HOLD
`,
    "query-basic": `@B5_GUI_AUDIO
PRINTFORML query_invalid={GETSOUNDORBGMINFO(-2)},{ISPLAYINGSOUND(-1)},{SOUNDCONTROL(-1, 0)},action={SOUNDCONTROL(0, 9)}
SETSOUNDVOLUME 37
PLAYSOUND "batch5-long.wav", 3
AWAIT 300
PRINTFORML query_playing={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},volume={GETSOUNDORBGMINFO(0, 4)}
B5_DUMMY = GETSOUNDORBGMINFO(0)
PRINTFORML query_omitted={B5_DUMMY},r0={RESULT:0},r1={RESULT:1},r2={RESULT:2},r3={RESULT:3},r4={RESULT:4}
PRINTL BATCH5_QUERY_BASIC_WAIT
WAIT
STOPSOUND
PRINTL BATCH5_QUERY_BASIC_DONE
$B5_QUERY_BASIC_HOLD
WAIT
GOTO B5_QUERY_BASIC_HOLD
`,
    "rate-low": `@B5_GUI_AUDIO
PLAYSOUND "batch5-audible-rate.wav", 1
AWAIT 300
PRINTFORML rate_low_ret={SOUNDCONTROL(0, 3, 1)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTL BATCH5_RATE_LOW_WAIT
WAIT
PRINTFORML rate_low_stop={SOUNDCONTROL(0, 2)},state={ISPLAYINGSOUND(0)}
PRINTL BATCH5_RATE_LOW_DONE
$B5_RATE_LOW_HOLD
WAIT
GOTO B5_RATE_LOW_HOLD
`,
    "rate-high": `@B5_GUI_AUDIO
PLAYSOUND "batch5-audible-rate.wav", 1
AWAIT 300
PRINTFORML rate_high_ret={SOUNDCONTROL(0, 3, 2000)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTL BATCH5_RATE_HIGH_WAIT
WAIT
STOPSOUND
PRINTL BATCH5_RATE_HIGH_DONE
$B5_RATE_HIGH_HOLD
WAIT
GOTO B5_RATE_HIGH_HOLD
`,
    channels: `@B5_GUI_AUDIO
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PRINTFORML channel_states={ISPLAYINGSOUND(0)},{ISPLAYINGSOUND(1)},{ISPLAYINGSOUND(2)},{ISPLAYINGSOUND(3)},{ISPLAYINGSOUND(4)},{ISPLAYINGSOUND(5)},{ISPLAYINGSOUND(6)},{ISPLAYINGSOUND(7)},{ISPLAYINGSOUND(8)},{ISPLAYINGSOUND(9)}
PRINTL BATCH5_CHANNELS_FULL_WAIT
WAIT
PLAYSOUND "batch5-short.wav", 2
PRINTFORML channel_overwrite_0_duration={GETSOUNDORBGMINFO(0, 1)}
B5_DUMMY = SOUNDCONTROL(3, 0)
PLAYSOUND "batch5-short.wav", 2
PRINTFORML channel_paused_reused_3_duration={GETSOUNDORBGMINFO(3, 1)}
STOPSOUND
PRINTL BATCH5_CHANNELS_DONE
$B5_CHANNELS_HOLD
WAIT
GOTO B5_CHANNELS_HOLD
`,
    natural: `@B5_GUI_AUDIO
PLAYSOUND "batch5-short.wav", 2
AWAIT 2500
PRINTFORML natural_state={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},position={GETSOUNDORBGMINFO(0, 2)}
PRINTL BATCH5_NATURAL_DONE
$B5_NATURAL_HOLD
WAIT
GOTO B5_NATURAL_HOLD
`,
    errors: `@B5_GUI_AUDIO
PLAYSOUND "batch5-corrupt.wav", 1
AWAIT 100
PRINTL BATCH5_CORRUPT_CONTINUED
$B5_ERRORS_HOLD
WAIT
GOTO B5_ERRORS_HOLD
`,
    bgm: `@B5_GUI_AUDIO
PLAYBGM "batch5-long.wav"
AWAIT 250
PRINTFORML bgm_probe_playing={ISPLAYINGBGM()},duration={GETSOUNDORBGMINFO(-1, 1)}
PRINTFORML bgm_probe_pause={BGMCONTROL(0)}
PRINTL BATCH5_BGM_PAUSED_WAIT
WAIT
PRINTFORML bgm_probe_paused={ISPLAYINGBGM()},position={GETSOUNDORBGMINFO(-1, 2)}
PRINTFORML bgm_probe_resume={BGMCONTROL(1)}
PRINTFORML bgm_probe_rate={BGMCONTROL(3, 250, 1)},speed={GETSOUNDORBGMINFO(-1, 5)}
PRINTFORML bgm_probe_stop={BGMCONTROL(2)},state={ISPLAYINGBGM()}
PRINTL BATCH5_BGM_DONE
$B5_BGM_HOLD
WAIT
GOTO B5_BGM_HOLD
`,
    controls: `@B5_GUI_AUDIO
SETSOUNDVOLUME 37
PLAYSOUND "batch5-audible.wav", 1
AWAIT 300
PRINTFORML controls_started={ISPLAYINGSOUND(0)},duration={GETSOUNDORBGMINFO(0, 1)},volume={GETSOUNDORBGMINFO(0, 4)}
PRINTFORML controls_pause={SOUNDCONTROL(0, 0)}
AWAIT 350
PRINTFORML controls_paused={ISPLAYINGSOUND(0)},position={GETSOUNDORBGMINFO(0, 2)}
PRINTFORML controls_resume={SOUNDCONTROL(0, 1)}
AWAIT 300
PRINTFORML controls_rate={SOUNDCONTROL(0, 3, 250, 1)},speed={GETSOUNDORBGMINFO(0, 5)}
PRINTFORML controls_stop={SOUNDCONTROL(0, 2)},state={ISPLAYINGSOUND(0)}
PRINTL BATCH5_CONTROLS_DONE
$B5_CONTROLS_HOLD
WAIT
GOTO B5_CONTROLS_HOLD
`,
    stress: `@B5_GUI_AUDIO
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PLAYSOUND "batch5-long.wav", 3
PRINTFORML stress_channels={ISPLAYINGSOUND(0)},{ISPLAYINGSOUND(1)},{ISPLAYINGSOUND(2)},{ISPLAYINGSOUND(3)},{ISPLAYINGSOUND(4)},{ISPLAYINGSOUND(5)},{ISPLAYINGSOUND(6)},{ISPLAYINGSOUND(7)},{ISPLAYINGSOUND(8)},{ISPLAYINGSOUND(9)}
PLAYSOUND "batch5-short.wav", 2
PRINTFORML stress_overwrite_duration={GETSOUNDORBGMINFO(0, 1)}
PLAYSOUND "batch5-corrupt.wav", 1
AWAIT 100
PLAYBGM "batch5-long.wav"
AWAIT 250
PRINTFORML stress_bgm={ISPLAYINGBGM()},duration={GETSOUNDORBGMINFO(-1, 1)}
STOPBGM
STOPSOUND
PRINTL BATCH5_STRESS_DONE
$B5_STRESS_HOLD
WAIT
GOTO B5_STRESS_HOLD
`,
  };
  return scripts[stage];
}

function isChildPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function replaceExactlyOnce(value, search, replacement, label) {
  const matches =
    typeof search === "string"
      ? value.split(search).length - 1
      : [
          ...value.matchAll(
            new RegExp(
              search.source,
              search.flags.includes("g") ? search.flags : `${search.flags}g`,
            ),
          ),
        ].length;
  if (matches !== 1) throw new Error(`${label} must match exactly once, found ${matches}`);
  return value.replace(search, replacement);
}

function pcmWave(durationMs, frequency, amplitude = 4_096) {
  const sampleRate = TEST_AUDIO_SAMPLE_RATE;
  const samples = Math.ceil((durationMs * sampleRate) / 1_000);
  const dataBytes = samples * 2;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + dataBytes, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude;
    wave.writeInt16LE(Math.round(value), 44 + index * 2);
  }
  return wave;
}
