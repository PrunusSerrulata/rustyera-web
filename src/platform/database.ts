import Dexie, { type EntityTable } from "dexie";

import { defaultPreferences, type Preferences } from "@/core/types";

interface SettingRecord {
  key: string;
  value: unknown;
}

interface HandleRecord {
  key: string;
  handle: FileSystemDirectoryHandle;
}

type StoredPreferences = Omit<Preferences, "schemaVersion"> & { schemaVersion: number };

class FrontendDatabase extends Dexie {
  settings!: EntityTable<SettingRecord, "key">;
  handles!: EntityTable<HandleRecord, "key">;

  constructor() {
    super("rustyera-web-v1");
    this.version(1).stores({ settings: "key", handles: "key" });
  }
}

export const database = new FrontendDatabase();

export async function loadBrowserPreferences(): Promise<Preferences> {
  const record = await database.settings.get("preferences");
  return normalizePreferences((record?.value ?? defaultPreferences()) as Preferences);
}

export async function saveBrowserPreferences(value: Preferences): Promise<Preferences> {
  const normalized = normalizePreferences(value);
  await database.settings.put({ key: "preferences", value: normalized });
  return normalized;
}

export function normalizePreferences(value: StoredPreferences): Preferences {
  const legacyDefaultFontSize =
    Number(value.schemaVersion ?? 1) < 2 && value.fontSizeOverridePx === 12;
  return {
    schemaVersion: 2,
    fontFamilyOverride: value.fontFamilyOverride || null,
    fontSizeOverridePx:
      value.fontSizeOverridePx == null || legacyDefaultFontSize
        ? null
        : Math.round(Math.min(72, Math.max(8, value.fontSizeOverridePx))),
    imageScale: Number.isFinite(value.imageScale)
      ? Math.min(4, Math.max(0.25, value.imageScale))
      : 1,
    masterVolume: Number.isFinite(value.masterVolume)
      ? Math.min(1, Math.max(0, value.masterVolume))
      : 1,
  };
}
