import { blake3 } from "@noble/hashes/blake3.js";

import type { ProjectPreferences } from "@/core/types";

const FILE_NAME = "preferences-v1.json";
const PROFILE = "browser";

interface PreferenceDocument {
  schemaVersion: 1;
  profiles: Record<string, { settings?: Record<string, string>; client?: Record<string, unknown> }>;
}

const emptyDocument = (): PreferenceDocument => ({ schemaVersion: 1, profiles: {} });

export class BrowserProjectPreferenceStore {
  private constructor(
    private readonly projectRoot: FileSystemDirectoryHandle | undefined,
    private readonly privateRoot: FileSystemDirectoryHandle | undefined,
    private document: PreferenceDocument,
    readonly writable: boolean,
    readonly error = "",
  ) {}

  static async source(root: FileSystemDirectoryHandle): Promise<BrowserProjectPreferenceStore> {
    try {
      const privateDirectory = await root.getDirectoryHandle(".rustyera");
      const document = await readDocument(privateDirectory);
      return new BrowserProjectPreferenceStore(root, privateDirectory, document, true);
    } catch (error) {
      if (isNotFound(error))
        return new BrowserProjectPreferenceStore(root, undefined, emptyDocument(), true);
      return new BrowserProjectPreferenceStore(
        root,
        undefined,
        emptyDocument(),
        false,
        `无法读取项目偏好：${String(error)}`,
      );
    }
  }

  static async packaged(bytes: Uint8Array): Promise<BrowserProjectPreferenceStore> {
    const hash = [...blake3(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const storage = await navigator.storage.getDirectory();
    const projects = await storage.getDirectoryHandle("project-preferences", { create: true });
    const directory = await projects.getDirectoryHandle(hash, { create: true });
    try {
      return new BrowserProjectPreferenceStore(
        undefined,
        directory,
        await readDocument(directory),
        true,
      );
    } catch (error) {
      return new BrowserProjectPreferenceStore(
        undefined,
        directory,
        emptyDocument(),
        false,
        `无法读取项目偏好：${String(error)}`,
      );
    }
  }

  values(): ProjectPreferences {
    const profile = this.document.profiles[PROFILE] ?? {};
    const client = profile.client ?? {};
    return {
      settings: { ...(profile.settings ?? {}) },
      imageScale: finite(client.imageScale),
      masterVolume: finite(client.masterVolume),
      trustProjectFileMetadata:
        typeof client.trustProjectFileMetadata === "boolean"
          ? client.trustProjectFileMetadata
          : undefined,
      interactionAssistMode: interactionAssistMode(client.interactionAssistMode),
    };
  }

  async save(value: ProjectPreferences): Promise<ProjectPreferences> {
    if (!this.writable) throw new Error(this.error || "项目偏好为只读");
    let directory = this.privateRoot;
    if (!directory && this.projectRoot)
      directory = await this.projectRoot.getDirectoryHandle(".rustyera", { create: true });
    if (!directory) throw new Error("项目偏好目录不可用");
    try {
      this.document = await readDocument(directory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.document = emptyDocument();
    }
    this.document.profiles[PROFILE] = {
      settings: { ...value.settings },
      client: {
        ...(value.imageScale == null ? {} : { imageScale: value.imageScale }),
        ...(value.masterVolume == null ? {} : { masterVolume: value.masterVolume }),
        ...(value.trustProjectFileMetadata == null
          ? {}
          : { trustProjectFileMetadata: value.trustProjectFileMetadata }),
        ...(value.interactionAssistMode == null
          ? {}
          : { interactionAssistMode: value.interactionAssistMode }),
      },
    };
    const handle = await directory.getFileHandle(FILE_NAME, { create: true });
    const writer = await handle.createWritable({ keepExistingData: false });
    try {
      await writer.write(new TextEncoder().encode(`${JSON.stringify(this.document, null, 2)}\n`));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    return this.values();
  }
}

async function readDocument(directory: FileSystemDirectoryHandle): Promise<PreferenceDocument> {
  const handle = await directory.getFileHandle(FILE_NAME);
  const file = await handle.getFile();
  const value: unknown = JSON.parse(await file.text());
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.profiles))
    throw new Error("项目偏好文件版本或结构无效");
  const profile = value.profiles[PROFILE];
  if (profile != null) validateActiveProfile(profile);
  return value as unknown as PreferenceDocument;
}

function validateActiveProfile(value: unknown): void {
  if (!isRecord(value)) throw new Error(`${PROFILE} 偏好分区不是对象`);
  if (Object.keys(value).some((key) => !["settings", "client"].includes(key)))
    throw new Error(`${PROFILE} 偏好分区包含未知字段`);
  if (value.settings != null) {
    if (
      !isRecord(value.settings) ||
      !Object.entries(value.settings).every(
        ([code, setting]) => typeof code === "string" && typeof setting === "string",
      )
    )
      throw new Error(`${PROFILE}.settings 必须只包含字符串键值`);
  }
  if (value.client == null) return;
  if (!isRecord(value.client)) throw new Error(`${PROFILE}.client 不是对象`);
  if (
    Object.keys(value.client).some(
      (key) =>
        ![
          "imageScale",
          "masterVolume",
          "trustProjectFileMetadata",
          "interactionAssistMode",
        ].includes(key),
    )
  )
    throw new Error(`${PROFILE}.client 包含未知字段`);
  const imageScale = value.client.imageScale;
  if (
    imageScale != null &&
    (typeof imageScale !== "number" ||
      !Number.isFinite(imageScale) ||
      imageScale < 0.25 ||
      imageScale > 4)
  )
    throw new Error("imageScale 必须在 0.25 到 4 之间");
  const masterVolume = value.client.masterVolume;
  if (
    masterVolume != null &&
    (typeof masterVolume !== "number" ||
      !Number.isFinite(masterVolume) ||
      masterVolume < 0 ||
      masterVolume > 1)
  )
    throw new Error("masterVolume 必须在 0 到 1 之间");
  if (
    value.client.trustProjectFileMetadata != null &&
    typeof value.client.trustProjectFileMetadata !== "boolean"
  )
    throw new Error("trustProjectFileMetadata 必须是布尔值");
  if (
    value.client.interactionAssistMode != null &&
    !["off", "on", "auto"].includes(String(value.client.interactionAssistMode))
  )
    throw new Error("interactionAssistMode 必须是 off、on 或 auto");
}

function interactionAssistMode(
  value: unknown,
): ProjectPreferences["interactionAssistMode"] | undefined {
  return value === "off" || value === "on" || value === "auto" ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
