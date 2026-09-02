import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { waitForRuntimeProgress } from "./runtime-progress.mjs";
import { snakeAudioRelations } from "../../scripts/web-test-runtime.mjs";

const enabled = process.env.VITE_RUSTYERA_TAURI_SNAKE_AUDIO === "1" ? describe : describe.skip;

enabled("Tauri snake audio provider", () => {
  it("reports real revision-bound playback state through the shared WebView provider", async () => {
    const project = process.env.VITE_RUSTYERA_TEST_PROJECT;
    assert.ok(project, "runner must provide an isolated project copy");
    const { stage = "full" } = JSON.parse(
      await readFile(path.join(project, "audio-stage.json"), "utf8"),
    );
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__RUSTYERA_TEST__?.snapshot())),
      { timeout: 20_000, interval: 100 },
    );
    await browser.execute(() =>
      window.__RUSTYERA_TEST__.configure({
        start: { type: "new_game", seed: "123456" },
        clock: "2026-01-01T00:00:00Z",
      }),
    );
    await $(".welcome .primary").click();
    const snapshot = () => browser.execute(() => window.__RUSTYERA_TEST__.snapshot());
    if (stage === "cache") {
      const cache = path.join(
        project,
        ".rustyera/profiles/emuera.skia.snake/.rustyera/cache/compiled-project.reracache",
      );
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio cache-only fixture completion",
        totalTimeout: 30_000,
        accept: async (state) => {
          if (!state?.output?.some((line) => line.includes("BATCH5_CACHE_READY"))) return false;
          if (state.transfer?.export != null) return false;
          if (
            !state.logs?.some((entry) =>
              String(entry?.message).includes("runtime.compiled_cache_ready"),
            )
          )
            return false;
          try {
            await access(cache);
            return true;
          } catch {
            return false;
          }
        },
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const bytes = await readFile(cache);
      assert.equal(bytes.subarray(0, 8).toString(), "RERACACH");
      assert.ok((await stat(cache)).size > 8);
      console.log(JSON.stringify({ stage, project, cache, cacheBytes: bytes.length }));
      return;
    }
    if (stage === "single") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio single audible playback completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_SINGLE_DONE")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const output = result.output.join("\n");
      for (const marker of [
        "BATCH5_SINGLE_BEFORE_PLAY",
        "BATCH5_SINGLE_PLAY_RETURNED",
        "BATCH5_SINGLE_DONE",
        "single_playing=0,duration=2000",
        "volume=100",
      ])
        assert.ok(output.includes(marker), `missing single-audio result ${marker}`);
      const position = /single_playing=0,duration=2000,position=(\d+),volume=100/.exec(output);
      assert.ok(position, "the single-audio session did not report its provider position");
      assert.ok(Number(position[1]) > 0 && Number(position[1]) < 2_000);
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.active, 0);
      console.log(
        JSON.stringify({
          stage,
          project,
          audioPlayback: result.audioPlayback,
          output: result.output,
        }),
      );
      return;
    }
    if (stage === "pause") {
      const paused = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio pause-only stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_PAUSE_CONTROL_RETURNED")),
      });
      assert.equal(paused.bridgeKind, "tauri");
      assert.equal(paused.fault, null);
      assert.equal(paused.audioProvider?.["sound:0"]?.state, "paused");
      assert.equal(paused.audioProvider?.["sound:0"]?.resourceId, "sound/batch5-audible.wav");
      assert.equal(paused.audioProvider?.["sound:0"]?.durationMs, 2_000);
      assert.ok(paused.audioProvider?.["sound:0"]?.positionMs > 0);
      assert.equal(paused.audioPlayback?.["sound/batch5-audible.wav"]?.starts, 1);
      assert.equal(paused.audioPlayback?.["sound/batch5-audible.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio pause-only query completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_PAUSE_DONE")),
      });
      const output = result.output.join("\n");
      for (const marker of [
        "BATCH5_PAUSE_BEFORE_PLAY",
        "BATCH5_PAUSE_PLAY_RETURNED",
        "BATCH5_PAUSE_BEFORE_CONTROL",
        "pause_ret=1",
        "BATCH5_PAUSE_CONTROL_RETURNED",
        "pause_state=-1",
        "BATCH5_PAUSE_DONE",
      ])
        assert.ok(output.includes(marker), `missing pause-only result ${marker}`);
      const position = /pause_state=-1,position=(\d+)/.exec(output);
      assert.ok(position, "the pause-only session did not report its paused position");
      assert.ok(Number(position[1]) > 0 && Number(position[1]) < 2_000);
      assert.ok(
        Math.abs(Number(position[1]) - paused.audioProvider["sound:0"].positionMs) <= 100,
        "the runtime pause position diverged from the stable media provider position",
      );
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.active, 0);
      console.log(
        JSON.stringify({
          stage,
          project,
          audioPlayback: result.audioPlayback,
          output: result.output,
        }),
      );
      return;
    }
    if (stage === "resume") {
      const paused = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio resume stable paused wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RESUME_PAUSED")),
      });
      assert.equal(paused.bridgeKind, "tauri");
      assert.equal(paused.fault, null);
      assert.equal(paused.audioProvider?.["sound:0"]?.state, "paused");
      assert.ok(paused.audioProvider?.["sound:0"]?.positionMs > 0);
      const pausedPosition = paused.audioProvider["sound:0"].positionMs;
      assert.equal(paused.audioPlayback?.["sound/batch5-audible-long.wav"]?.starts, 1);
      assert.equal(paused.audioPlayback?.["sound/batch5-audible-long.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const resumed = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio resumed stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RESUME_PLAYING_WAIT")),
      });
      const output = resumed.output.join("\n");
      for (const marker of [
        "BATCH5_RESUME_BEFORE_PLAY",
        "BATCH5_RESUME_PLAY_RETURNED",
        "resume_pause_ret=1",
        "BATCH5_RESUME_PAUSED",
        "resume_ret=1",
        "BATCH5_RESUME_CONTROL_RETURNED",
        "resume_state=0",
        "BATCH5_RESUME_PLAYING_WAIT",
      ])
        assert.ok(output.includes(marker), `missing resume result ${marker}`);
      const position = /resume_state=0,position=(\d+)/.exec(output);
      assert.ok(position, "the resume session did not report its playing position");
      assert.ok(Number(position[1]) >= pausedPosition && Number(position[1]) < 8_000);
      assert.equal(resumed.audioProvider?.["sound:0"]?.state, "playing");
      assert.ok(resumed.audioProvider?.["sound:0"]?.positionMs > pausedPosition);
      assert.equal(resumed.audioPlayback?.["sound/batch5-audible-long.wav"]?.starts, 1);
      assert.equal(resumed.audioPlayback?.["sound/batch5-audible-long.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio resume stop completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_RESUME_DONE")),
      });
      assert.equal(result.audioPlayback?.["sound/batch5-audible-long.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-audible-long.wav"]?.active, 0);
      console.log(
        JSON.stringify({
          stage,
          project,
          pausedPosition,
          resumedPosition: resumed.audioProvider["sound:0"].positionMs,
          output: result.output,
        }),
      );
      return;
    }
    if (stage === "rate-input") {
      const playing = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate input probe wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_INPUT_WAIT")),
      });
      assert.equal(playing.bridgeKind, "tauri");
      assert.equal(playing.fault, null);
      assert.equal(playing.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(playing.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      assert.equal(playing.audioProvider?.["sound:0"]?.preservePitch, false);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate input probe return",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_INPUT_RETURNED")),
      });
      const output = result.output.join("\n");
      for (const marker of [
        "BATCH5_RATE_INPUT_BEFORE_PLAY",
        "BATCH5_RATE_INPUT_PLAY_RETURNED",
        "rate_input_ret=1,speed=250",
        "BATCH5_RATE_INPUT_WAIT",
        "BATCH5_RATE_INPUT_RETURNED",
      ])
        assert.ok(output.includes(marker), `missing rate-input probe result ${marker}`);
      assert.equal(result.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(result.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "rate-pause") {
      const playing = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate pause probe wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_PAUSE_WAIT")),
      });
      assert.equal(playing.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(playing.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate pause probe return",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_PAUSE_RETURNED")),
      });
      const output = result.output.join("\n");
      for (const marker of [
        "BATCH5_RATE_PAUSE_BEFORE_PLAY",
        "BATCH5_RATE_PAUSE_PLAY_RETURNED",
        "rate_pause_rate_ret=1,speed=250",
        "BATCH5_RATE_PAUSE_WAIT",
        "BATCH5_RATE_PAUSE_BEFORE_CONTROL",
        "rate_pause_ret=1",
        "BATCH5_RATE_PAUSE_RETURNED",
      ])
        assert.ok(output.includes(marker), `missing rate-pause probe result ${marker}`);
      assert.equal(result.audioProvider?.["sound:0"]?.state, "paused");
      assert.equal(result.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      assert.ok(result.audioProvider?.["sound:0"]?.positionMs > 0);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "rate") {
      const playing = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate stable playing wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_PLAYING_WAIT")),
      });
      assert.equal(playing.bridgeKind, "tauri");
      assert.equal(playing.fault, null);
      const output = playing.output.join("\n");
      for (const marker of [
        "BATCH5_RATE_BEFORE_PLAY",
        "BATCH5_RATE_PLAY_RETURNED",
        "rate_ret=1",
        "rate_state=0",
        "speed=250",
        "BATCH5_RATE_PLAYING_WAIT",
      ])
        assert.ok(output.includes(marker), `missing rate result ${marker}`);
      const before = /rate_before_position=(\d+)/.exec(output);
      const queried = /rate_state=0,position=(\d+),speed=250/.exec(output);
      assert.ok(before && queried, "the rate session did not report both positions");
      assert.ok(Number(before[1]) > 0);
      assert.ok(Number(queried[1]) >= Number(before[1]));
      assert.equal(playing.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(playing.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      assert.equal(playing.audioProvider?.["sound:0"]?.preservePitch, false);
      assert.ok(playing.audioProvider?.["sound:0"]?.positionMs > Number(before[1]));
      assert.equal(playing.audioPlayback?.["sound/batch5-audible-rate.wav"]?.starts, 1);
      assert.equal(playing.audioPlayback?.["sound/batch5-audible-rate.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio rate stop completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_RATE_DONE")),
      });
      for (const marker of [
        "BATCH5_RATE_BEFORE_STOP",
        "rate_stop_ret=1",
        "BATCH5_RATE_STOP_RETURNED",
        "BATCH5_RATE_DONE",
      ])
        assert.ok(result.output.join("\n").includes(marker), `missing rate-stop result ${marker}`);
      assert.equal(result.audioPlayback?.["sound/batch5-audible-rate.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-audible-rate.wav"]?.active, 0);
      console.log(
        JSON.stringify({
          stage,
          project,
          beforePosition: Number(before[1]),
          queriedPosition: Number(queried[1]),
          providerPosition: playing.audioProvider["sound:0"].positionMs,
          output: result.output,
        }),
      );
      return;
    }
    if (stage === "queries") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio query and return-code completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_QUERIES_DONE")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const output = result.output.join("\n");
      for (const marker of [
        "query_invalid=0,-1,-1,action=-2",
        "query_playing=0,duration=5000,volume=37",
        "query_rate=1,speed=250,pitch0=1,pitch1=1",
        "query_speed_low=10",
        "query_speed_high=1000",
        "query_stop=1,state=-1,duration=0,position=0",
        "BATCH5_QUERIES_DONE",
      ])
        assert.ok(output.includes(marker), `missing audio-query result ${marker}`);
      const omitted = /query_omitted=(\d+),r0=(\d+),r1=(\d+),r2=(-?\d+),r3=(\d+),r4=(\d+)/.exec(
        output,
      );
      assert.ok(omitted, "the omitted-selector query did not populate RESULT:0..4");
      assert.equal(Number(omitted[1]), 5_000);
      assert.equal(Number(omitted[2]), Number(omitted[1]));
      assert.ok(Number(omitted[3]) > 0 && Number(omitted[3]) < 5_000);
      assert.equal(Number(omitted[4]), 1);
      assert.equal(Number(omitted[5]), 37);
      assert.equal(Number(omitted[6]), 100);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.active, 0);
      assertReleasedAudio(result, ["sound:0"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "query-basic") {
      const playing = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio basic query stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_QUERY_BASIC_WAIT")),
      });
      assert.equal(playing.bridgeKind, "tauri");
      assert.equal(playing.fault, null);
      const output = playing.output.join("\n");
      for (const marker of [
        "query_invalid=0,-1,-1,action=-2",
        "query_playing=0,duration=5000,volume=37",
        "BATCH5_QUERY_BASIC_WAIT",
      ])
        assert.ok(output.includes(marker), `missing basic audio-query result ${marker}`);
      const omitted = /query_omitted=(\d+),r0=(\d+),r1=(\d+),r2=(-?\d+),r3=(\d+),r4=(\d+)/.exec(
        output,
      );
      assert.ok(omitted, "the basic omitted-selector query did not populate RESULT:0..4");
      assert.equal(Number(omitted[1]), 5_000);
      assert.equal(Number(omitted[2]), Number(omitted[1]));
      assert.ok(Number(omitted[3]) > 0 && Number(omitted[3]) < 5_000);
      assert.equal(Number(omitted[4]), 1);
      assert.equal(Number(omitted[5]), 37);
      assert.equal(Number(omitted[6]), 100);
      assert.equal(playing.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(playing.audioProvider?.["sound:0"]?.resourceId, "sound/batch5-long.wav");
      assert.equal(playing.audioProvider?.["sound:0"]?.durationMs, 5_000);
      assert.equal(playing.audioPlayback?.["sound/batch5-long.wav"]?.starts, 1);
      assert.equal(playing.audioPlayback?.["sound/batch5-long.wav"]?.active, 1);
      assert.equal(playing.memory?.audioBuffers?.count, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio basic query release",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_QUERY_BASIC_DONE")),
      });
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.active, 0);
      assertReleasedAudio(result, ["sound:0"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "rate-low") {
      const playing = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio minimum clamped rate stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_LOW_WAIT")),
      });
      assert.equal(playing.bridgeKind, "tauri");
      assert.equal(playing.fault, null);
      const output = playing.output.join("\n");
      assert.ok(output.includes("rate_low_ret=1,speed=10"));
      assert.equal(playing.audioProvider?.["sound:0"]?.state, "playing");
      assert.equal(playing.audioProvider?.["sound:0"]?.rateMillionths, 100_000);
      assert.equal(playing.audioPlayback?.["sound/batch5-audible-rate.wav"]?.starts, 1);
      assert.equal(playing.audioPlayback?.["sound/batch5-audible-rate.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio minimum clamped rate stop",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_RATE_LOW_DONE")),
      });
      assert.ok(result.output.join("\n").includes("rate_low_stop=1,state=-1"));
      assert.equal(result.audioPlayback?.["sound/batch5-audible-rate.wav"]?.active, 0);
      assertReleasedAudio(result, ["sound:0"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "rate-high") {
      const high = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio maximum clamped rate stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_RATE_HIGH_WAIT")),
      });
      assert.equal(high.bridgeKind, "tauri");
      assert.equal(high.fault, null);
      assert.ok(high.output.join("\n").includes("rate_high_ret=1,speed=1000"));
      assert.equal(high.audioProvider?.["sound:0"]?.rateMillionths, 10_000_000);
      assert.equal(high.audioPlayback?.["sound/batch5-audible-rate.wav"]?.starts, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio maximum clamped rate release",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_RATE_HIGH_DONE")),
      });
      assert.equal(result.audioPlayback?.["sound/batch5-audible-rate.wav"]?.active, 0);
      assertReleasedAudio(result, ["sound:0"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "channels") {
      const full = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio ten-channel stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_CHANNELS_FULL_WAIT")),
      });
      assert.equal(full.bridgeKind, "tauri");
      assert.equal(full.fault, null);
      assert.ok(
        full.output.join("\n").includes("channel_states=0,1,2,3,4,5,6,7,8,9"),
        "the provider did not allocate all ten stable sound channels",
      );
      for (let channel = 0; channel < 10; channel += 1) {
        assert.equal(full.audioProvider?.[`sound:${channel}`]?.state, "playing");
        assert.equal(full.audioProvider?.[`sound:${channel}`]?.resourceId, "sound/batch5-long.wav");
      }
      assert.equal(full.audioPlayback?.["sound/batch5-long.wav"]?.starts, 10);
      assert.equal(full.audioPlayback?.["sound/batch5-long.wav"]?.active, 10);
      assert.equal(full.memory?.audioBuffers?.count, 10);
      assert.ok(full.memory?.audioBuffers?.estimatedBytes > 0);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio overwrite and paused-channel reuse completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_CHANNELS_DONE")),
      });
      const output = result.output.join("\n");
      for (const marker of [
        "channel_overwrite_0_duration=750",
        "channel_paused_reused_3_duration=750",
        "BATCH5_CHANNELS_DONE",
      ])
        assert.ok(output.includes(marker), `missing channel-allocation result ${marker}`);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.starts, 10);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.active, 0);
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.starts, 2);
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.active, 0);
      assertReleasedAudio(
        result,
        Array.from({ length: 10 }, (_, channel) => `sound:${channel}`),
      );
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "natural") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio finite-repeat natural completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_NATURAL_DONE")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const output = result.output.join("\n");
      assert.ok(
        output.includes("natural_state=-1,duration=0,position=0"),
        "finite repeat did not naturally release its provider resource",
      );
      assert.ok(output.includes("BATCH5_NATURAL_DONE"));
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.active, 0);
      assertReleasedAudio(result, ["sound:0"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "errors") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio corrupt-resource recovery",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_CORRUPT_CONTINUED")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      assert.ok(result.output.join("\n").includes("BATCH5_CORRUPT_CONTINUED"));
      assert.equal(result.audioProvider?.["sound:0"]?.state, "stopped");
      assert.equal(result.audioProvider?.["sound:0"]?.resourceId, null);
      assert.equal(result.audioProvider?.["sound:0"]?.pending, false);
      assert.match(
        String(result.audioProvider?.["sound:0"]?.failure),
        /frontend\.audio_decode_failed/,
      );
      assert.ok(
        result.logs?.some((entry) =>
          String(entry?.message).includes("frontend.audio_decode_failed"),
        ),
        "the corrupt resource did not produce a structured decode diagnostic",
      );
      assert.equal(result.memory?.audioBuffers?.count, 0);
      assert.equal(result.memory?.audioBuffers?.estimatedBytes, 0);
      console.log(JSON.stringify({ stage, project, output: result.output, logs: result.logs }));
      return;
    }
    if (stage === "bgm") {
      const paused = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio BGM paused stable wait",
        totalTimeout: 30_000,
        accept: (state) =>
          state?.wait != null &&
          state?.output?.some((line) => line.includes("BATCH5_BGM_PAUSED_WAIT")),
      });
      assert.equal(paused.bridgeKind, "tauri");
      assert.equal(paused.fault, null);
      const pausedOutput = paused.output.join("\n");
      for (const marker of [
        "bgm_probe_playing=1,duration=5000",
        "bgm_probe_pause=1",
        "BATCH5_BGM_PAUSED_WAIT",
      ])
        assert.ok(pausedOutput.includes(marker), `missing BGM pause result ${marker}`);
      assert.equal(paused.audioProvider?.bgm?.state, "paused");
      assert.equal(paused.audioProvider?.bgm?.resourceId, "sound/batch5-long.wav");
      assert.ok(paused.audioProvider?.bgm?.positionMs > 0);
      assert.equal(paused.audioPlayback?.["sound/batch5-long.wav"]?.starts, 1);
      assert.equal(paused.audioPlayback?.["sound/batch5-long.wav"]?.active, 1);
      await $(".prompt-bar button[type=submit]").click();
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio BGM resume-rate-stop completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_BGM_DONE")),
      });
      const output = result.output.join("\n");
      for (const marker of [
        "bgm_probe_paused=0",
        "bgm_probe_resume=1",
        "bgm_probe_rate=1,speed=250",
        "bgm_probe_stop=1,state=0",
        "BATCH5_BGM_DONE",
      ])
        assert.ok(output.includes(marker), `missing BGM control result ${marker}`);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.active, 0);
      assertReleasedAudio(result, ["bgm"]);
      console.log(JSON.stringify({ stage, project, output: result.output }));
      return;
    }
    if (stage === "stress") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio combined provider stress completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_STRESS_DONE")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const output = result.output.join("\n");
      for (const marker of [
        "stress_channels=0,1,2,3,4,5,6,7,8,9",
        "stress_overwrite_duration=750",
        "stress_bgm=1,duration=5000",
        "BATCH5_STRESS_DONE",
      ])
        assert.ok(output.includes(marker), `missing audio-stress result ${marker}`);
      assert.ok(
        result.logs?.some((entry) =>
          String(entry?.message).includes("frontend.audio_decode_failed"),
        ),
        "the stress decode failure did not produce its structured diagnostic",
      );
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.starts, 11);
      assert.equal(result.audioPlayback?.["sound/batch5-long.wav"]?.active, 0);
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-short.wav"]?.active, 0);
      assertReleasedAudio(result, [
        ...Array.from({ length: 10 }, (_, channel) => `sound:${channel}`),
        "bgm",
      ]);
      console.log(
        JSON.stringify({
          stage,
          project,
          audioPlayback: result.audioPlayback,
          output: result.output,
        }),
      );
      return;
    }
    if (stage === "controls") {
      const result = await waitForRuntimeProgress({
        browser,
        snapshot,
        label: "snake audio controls completion",
        totalTimeout: 30_000,
        accept: (state) => state?.output?.some((line) => line.includes("BATCH5_CONTROLS_DONE")),
      });
      assert.equal(result.bridgeKind, "tauri");
      assert.equal(result.fault, null);
      const output = result.output.join("\n");
      for (const marker of [
        "controls_started=0,duration=2000,volume=37",
        "controls_pause=1",
        "controls_paused=-1",
        "controls_resume=1",
        "controls_rate=1,speed=250",
        "controls_stop=1,state=-1",
        "BATCH5_CONTROLS_DONE",
      ])
        assert.ok(output.includes(marker), `missing audio-controls result ${marker}`);
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.starts, 1);
      assert.equal(result.audioPlayback?.["sound/batch5-audible.wav"]?.active, 0);
      assert.equal(result.audioProvider?.["sound:0"]?.rateMillionths, 2_500_000);
      assert.equal(result.audioProvider?.["sound:0"]?.preservePitch, true);
      console.log(
        JSON.stringify({
          stage,
          project,
          audioPlayback: result.audioPlayback,
          output: result.output,
        }),
      );
      return;
    }
    assert.equal(stage, "full", `unsupported snake audio fixture stage ${stage}`);
    const result = await waitForRuntimeProgress({
      browser,
      snapshot,
      label: "snake audio provider completion",
      totalTimeout: 60_000,
      accept: (state) => state?.output?.some((line) => line.includes("BATCH5_GUI_DONE")),
    });
    assert.equal(result.bridgeKind, "tauri");
    assert.equal(result.fault, null);
    const output = result.output.join("\n");
    for (const marker of [
      "invalid_get=0,invalid_is=-1,invalid_control=-1",
      "invalid_action=-2",
      "playing=0",
      "sound_play_duration=5000",
      "volume=37",
      "pause_ret=1",
      "paused_is=-1",
      "resume_ret=1",
      "resumed_is=0",
      "rate_omitted=1,speed=250,pitch_zero=1,pitch_nonzero=1",
      "speed_low=10",
      "speed_high=1000",
      "stop_ret=1,stopped=-1,stopped_duration=0,stopped_position=0",
      "channels=0,1,2,3,4,5,6,7,8,9",
      "all_busy_overwrite_0_duration=750",
      "paused_reused_3_duration=750",
      "short_natural_state=-1,duration=0,position=0",
      "corrupt_decode_continued=1",
      "final_pitch_nonzero=1",
      "bgm_playing=1",
      "bgm_pause_ret=1",
      "bgm_paused=0",
      "bgm_resume_ret=1",
      "bgm_stop_ret=1,bgm_stopped=0",
    ])
      assert.ok(output.includes(marker), `missing audio result ${marker}`);
    const relations = snakeAudioRelations({ output: result.output, frontend: result });
    assert.deepEqual(
      Object.entries(relations).filter(([, passed]) => !passed),
      [],
      `native audio relation failures: ${JSON.stringify(relations)}`,
    );
    console.log(
      JSON.stringify({
        project: process.env.VITE_RUSTYERA_TEST_PROJECT,
        bridgeKind: result.bridgeKind,
        audioPlayback: result.audioPlayback,
        output: result.output,
      }),
    );
  });
});

function assertReleasedAudio(state, targetKeys) {
  assert.equal(state.memory?.audioBuffers?.count, 0);
  assert.equal(state.memory?.audioBuffers?.estimatedBytes, 0);
  for (const key of targetKeys) {
    assert.equal(state.audioProvider?.[key]?.state, "stopped");
    assert.equal(state.audioProvider?.[key]?.resourceId, null);
    assert.equal(state.audioProvider?.[key]?.pending, false);
    assert.equal(state.audioProvider?.[key]?.failure, null);
  }
}
