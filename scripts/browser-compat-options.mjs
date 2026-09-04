import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateExpectedValues } from "./interop-assertions.mjs";
import { captureConfiguration, prepareCaptureInputs } from "./snake-service-capture-io.mjs";
import { injectInGameSaveFlow, injectInteractionAssistFlow } from "./web-test-lib.mjs";
import { collectFiles } from "./browser-compat-support.mjs";

export async function loadCompatibilityOptions(argv) {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const browserName = argv[argv.indexOf("--browser") + 1];
  if (!browserName || !["firefox", "safari"].includes(browserName)) {
    throw new Error("usage: browser-compat-test --browser <firefox|safari>");
  }
  const projectIndex = argv.indexOf("--project");
  if (projectIndex >= 0 && !argv[projectIndex + 1]) {
    throw new Error("--project requires a path");
  }
  const project = path.resolve(
    repository,
    projectIndex >= 0 ? argv[projectIndex + 1] : "../emuera.em/emuera-reference-cli/tests/fixture",
  );
  const projectFileIndex = argv.indexOf("--project-file");
  if (projectFileIndex >= 0 && !argv[projectFileIndex + 1]) {
    throw new Error("--project-file requires a path");
  }
  const projectFile =
    projectFileIndex >= 0 ? path.resolve(repository, argv[projectFileIndex + 1]) : undefined;
  const expectedOutputIndex = argv.indexOf("--expect-output");
  if (expectedOutputIndex >= 0 && !argv[expectedOutputIndex + 1])
    throw new Error("--expect-output requires a marker");
  const expectedOutput = expectedOutputIndex >= 0 ? argv[expectedOutputIndex + 1] : undefined;
  const checkTooltip = argv.includes("--check-tooltip");
  const fullProjectExport = argv.includes("--full-project-export");
  if (fullProjectExport && projectFile)
    throw new Error("full project export requires a source directory");
  const snakeData = argv.includes("--snake-data");
  const snakeServiceOracle = argv.includes("--snake-service-oracle");
  const oracleConfig = snakeServiceOracle
    ? await captureConfiguration(argv, project, browserName)
    : undefined;
  const oracleInputs = oracleConfig ? await prepareCaptureInputs(oracleConfig) : undefined;
  if (snakeData && projectIndex < 0) throw new Error("--snake-data requires --project");
  if (snakeData && projectFile)
    throw new Error("--snake-data requires the source fixture directory");
  const snakeServices = argv.includes("--snake-services");
  const snakeBatch1 = argv.includes("--snake-batch1");
  const snakeServiceLifecycle = argv.includes("--snake-service-lifecycle");
  const snakeAudio = argv.includes("--snake-audio");
  const snakeAudioStress = argv.includes("--snake-audio-stress");
  const snakeAudioFlow = snakeAudio || snakeAudioStress;
  const snakeInterop = argv.includes("--snake-interop");
  const nativeDriverInputs = argv.includes("--native-driver-inputs");
  const backgroundDom = argv.includes("--background-dom");
  const webdriverOpen = argv.includes("--webdriver-open");
  const safariAllowAutoplay = argv.includes("--safari-allow-autoplay");
  if (safariAllowAutoplay && browserName !== "safari")
    throw new Error("--safari-allow-autoplay requires Safari");
  if (webdriverOpen && (!backgroundDom || browserName !== "safari"))
    throw new Error("--webdriver-open requires Safari --background-dom");
  if (backgroundDom && nativeDriverInputs)
    throw new Error("--background-dom and --native-driver-inputs are distinct input modes");
  const stateIndex = argv.indexOf("--traditional-state");
  const expectationsIndex = argv.indexOf("--expect-watches");
  if (stateIndex >= 0 && !argv[stateIndex + 1])
    throw new Error("--traditional-state requires a save path");
  if (expectationsIndex >= 0 && !argv[expectationsIndex + 1])
    throw new Error("--expect-watches requires a JSON object path");
  const traditionalState =
    stateIndex >= 0 ? [...(await readFile(path.resolve(argv[stateIndex + 1])))] : undefined;
  const expectedWatches =
    expectationsIndex >= 0
      ? JSON.parse(await readFile(path.resolve(argv[expectationsIndex + 1]), "utf8"))
      : undefined;
  if (expectationsIndex >= 0) validateExpectedValues(expectedWatches);
  if (snakeInterop && (projectIndex < 0 || !expectedWatches || traditionalState))
    throw new Error(
      "--snake-interop requires --project and --expect-watches, without --traditional-state",
    );
  const replacementIndex = argv.indexOf("--replacement-project");
  const lifecycleReplacement =
    snakeServiceLifecycle && replacementIndex >= 0 && argv[replacementIndex + 1]
      ? path.resolve(repository, argv[replacementIndex + 1])
      : undefined;
  if (
    snakeServiceLifecycle &&
    (!lifecycleReplacement || (await realpath(lifecycleReplacement)) === (await realpath(project)))
  )
    throw new Error(
      "lifecycle requires --replacement-project pointing to the distinct successor fixture",
    );
  const lifecycleReplacementFiles = lifecycleReplacement
    ? await collectFiles(lifecycleReplacement)
    : undefined;
  if (
    Number(snakeData) +
      Number(snakeServices) +
      Number(snakeBatch1) +
      Number(snakeServiceLifecycle) +
      Number(snakeAudio) +
      Number(snakeAudioStress) +
      Number(snakeInterop) +
      Number(snakeServiceOracle) >
    1
  )
    throw new Error("choose one snake fixture flow");
  if (
    (snakeServices || snakeBatch1 || snakeServiceLifecycle || snakeServiceOracle) &&
    (projectIndex < 0 || projectFile)
  )
    throw new Error("snake service flows require --project source directory");
  if (snakeAudioFlow && projectIndex < 0)
    throw new Error("snake audio flows require --project source directory for fixture identity");
  const startupOnly =
    fullProjectExport ||
    argv.includes("--startup-only") ||
    Boolean(expectedOutput) ||
    snakeData ||
    snakeServices ||
    snakeBatch1 ||
    snakeServiceLifecycle ||
    snakeAudioFlow ||
    snakeInterop ||
    snakeServiceOracle ||
    Boolean(traditionalState);
  if (nativeDriverInputs && (!startupOnly || snakeServiceLifecycle || snakeServiceOracle))
    throw new Error("--native-driver-inputs requires a startup, output, or audio acceptance flow");
  if (backgroundDom && (!startupOnly || snakeServiceLifecycle || snakeServiceOracle))
    throw new Error("--background-dom requires a startup, output, or audio acceptance flow");
  const cacheInputSmoke = argv.includes("--cache-input-smoke");
  const logInputSmoke = argv.includes("--log-input-smoke");
  const settingsHotApply = argv.includes("--settings-hot-apply");
  const files = await collectFiles(project);
  if (projectIndex < 0) {
    const oracle = files.find((entry) => entry.path.toLowerCase() === "erb/oracle.erb");
    if (!oracle) throw new Error("browser compatibility fixture lacks erb/oracle.erb");
    oracle.base64 = Buffer.from(
      injectInteractionAssistFlow(
        injectInGameSaveFlow(Buffer.from(oracle.base64, "base64").toString("utf8")),
      ),
    ).toString("base64");
  }
  return {
    repository,
    browserName,
    projectIndex,
    project,
    projectFile,
    expectedOutput,
    checkTooltip,
    fullProjectExport,
    snakeData,
    snakeServiceOracle,
    oracleConfig,
    oracleInputs,
    snakeServices,
    snakeBatch1,
    snakeServiceLifecycle,
    snakeAudio,
    snakeAudioStress,
    snakeAudioFlow,
    snakeInterop,
    nativeDriverInputs,
    backgroundDom,
    webdriverOpen,
    safariAllowAutoplay,
    traditionalState,
    expectedWatches,
    lifecycleReplacement,
    lifecycleReplacementFiles,
    startupOnly,
    cacheInputSmoke,
    logInputSmoke,
    settingsHotApply,
    files,
  };
}
