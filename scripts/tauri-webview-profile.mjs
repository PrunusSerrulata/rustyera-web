import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

/** A WebView2 user-data folder also selects its browser process collection. */
export async function isolatedWebviewEnvironment(
  repository,
  environment,
  platform = process.platform,
) {
  if (platform !== "win32") return { ...environment };
  const parent = path.resolve(repository, ".rustyera/test-runs/webview2");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(path.join(parent, "session-"));
  return { ...environment, WEBVIEW2_USER_DATA_FOLDER: profile };
}
