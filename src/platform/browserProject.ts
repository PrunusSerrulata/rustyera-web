import { blake3 } from "@noble/hashes/blake3.js";
import { type CompatibilityIdentity } from "@/core/compatibility";
import type { ProjectReloadScope, ProjectReloadTargets } from "@/core/types";
import {
  equalBytes,
  errorKind,
  optionalFileHandle,
  safePath,
} from "@/platform/browserProjectFilesystem";
import {
  isReloadableCategory,
  projectReloadScopeMatches,
  projectReloadSelector,
  saveSlotName,
} from "@/platform/browserProjectUtilities";
import { dispatchBrowserStorage } from "@/platform/browserProjectStorage";
import {
  maximumResourceReadBytes,
  type BrowserStorageResource,
} from "@/platform/browserResourceStorage";
import { isPackagedProjectFontPath, type ProjectFontSource } from "@/platform/projectFonts";
import type { ScannedFile } from "@/platform/browserProjectScanner";
import {
  checkedSaveSlotCount,
  compareScannedFiles,
  comparePaths,
  payloadByteLength,
  runtimeReloadChange,
  runtimeReloadUpsert,
} from "@/platform/browserProjectSupport";
import { BrowserProjectBase } from "@/platform/browserProjectBase";

export { scanBrowserProjectFile } from "@/platform/browserProjectScanner";

export { cacheIdentityManifest } from "@/platform/browserProjectSupport";

export type { ScannedFile } from "@/platform/browserProjectScanner";

export {
  decodeProjectSource,
  decodeProtocolBytes,
  normalizeResourceManifest,
  runBounded,
  saveSlotName,
  storageDirectoryName,
} from "@/platform/browserProjectUtilities";

export interface BrowserTraditionalSaveSlot {
  slot: number;
  occupied: boolean;
}

export interface BrowserManifest {
  project_revision: number;
  files: ScannedFile[];
  /** Absent only between file scanning and the mandatory core compatibility resolution. */
  compatibility?: CompatibilityIdentity;
}

export interface BrowserFullManifestSpool {
  totalBytes: number;
  read(offset: number, maximumBytes: number): Promise<Uint8Array>;
  release(): Promise<void>;
}

export type FileScanProgress = (completed: number, total: number) => void;

export type ProjectConfigurationUpdatePreparer = (
  projectFile: Uint8Array,
  expectedDigest: Uint8Array,
  contents: string,
) => Promise<Uint8Array>;

export type PackagedFileMaterializer = () => Promise<FileSystemFileHandle>;

export type PackagedResourceReader = (
  relativePath: string,
  maximumBytes?: number,
) => Promise<Uint8Array>;

interface PendingBrowserReload {
  candidate: BrowserProject;
  manifest: BrowserManifest;
  runtimeManifestSparse: boolean;
}

export interface BrowserProjectScanMetrics {
  enumerateMs: number;
  indexReadMs: number;
  indexWriteMs: number;
  statMs: number;
  sourceReadDecodeHashMs: number;
  sourceIndexPresent: boolean;
  sourceIndexTrusted: boolean;
  sourceIndexReusedFiles: number;
  sourceIndexHashedFiles: number;
}

export class BrowserProject extends BrowserProjectBase {
  private pendingReload?: PendingBrowserReload;

  async projectReloadTargets(): Promise<ProjectReloadTargets> {
    if (this.embeddedManifest()) return { folders: [], scripts: [] };
    const paths = new Set(
      (this.manifestValue?.files ?? [])
        .filter((file) => isReloadableCategory(file.category))
        .map((file) => file.relative_path),
    );
    const { files: current } = await this.enumerateFiles();
    for (const file of current) {
      if (isReloadableCategory(file.category)) paths.add(file.relativePath);
    }
    const scripts = [...paths].sort(comparePaths);
    const folders = [
      ...new Set(scripts.map((path) => path.slice(0, path.lastIndexOf("/") + 1).slice(0, -1))),
    ]
      .filter(Boolean)
      .sort(comparePaths);
    return { folders, scripts };
  }

  async prepareReloadBaseline(progress?: FileScanProgress): Promise<void> {
    if (this.embeddedManifest()) return;
    await this.materialize(progress);
  }

  async reloadRequest(scope: ProjectReloadScope, progress?: FileScanProgress): Promise<any> {
    if (this.embeddedManifest()) throw new Error("项目文件不包含可热重载的外部源码目录");
    if (this.pendingReload) throw new Error("已有项目热重载正在等待 Runtime 确认");
    const selector = projectReloadSelector(scope);
    const previous = this.manifestValue ?? (await this.scan(progress));
    const candidate = new BrowserProject(
      this.root,
      this.revision + 1,
      this.name,
      this.sourceIndexTrusted,
    );
    if (this.compatibilityValue) candidate.setCompatibility(this.compatibilityValue);
    let current = await candidate.scan(progress);
    const oldByPath = new Map(previous.files.map((file) => [file.relative_path, file]));
    const newByPath = new Map(current.files.map((file) => [file.relative_path, file]));
    const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort(comparePaths);
    const changes: any[] = [];
    if (this.runtimeManifestSparse) {
      // A constrained runtime deliberately retained only file identities. Rebuild its complete
      // manifest from the authorized directory for every hot reload; scoped delta baselines are
      // available only while the runtime still owns all source payloads.
      current = await candidate.materialize(progress);
      const currentPaths = new Set(current.files.map((file) => file.relative_path));
      this.pendingReload = { candidate, manifest: current, runtimeManifestSparse: false };
      return {
        base_revision: previous.project_revision,
        target_revision: current.project_revision,
        changes: [
          ...current.files.map((file) => runtimeReloadUpsert(file)),
          ...previous.files
            .filter((file) => !currentPaths.has(file.relative_path))
            .map((file) =>
              runtimeReloadChange({
                type: "remove",
                category: file.category,
                relative_path: file.relative_path,
              }),
            ),
        ],
      };
    }
    for (const path of paths) {
      const oldFile = oldByPath.get(path);
      const newFile = newByPath.get(path);
      const category = newFile?.category ?? oldFile?.category;
      if (!category || !projectReloadScopeMatches(selector, path, category)) continue;
      if (
        oldFile &&
        newFile &&
        oldFile.category === newFile.category &&
        equalBytes(oldFile.content_hash, newFile.content_hash)
      ) {
        continue;
      }
      if (newFile) changes.push({ type: "upsert", file: newFile });
      else if (oldFile)
        changes.push({
          type: "remove",
          category: oldFile.category,
          relative_path: oldFile.relative_path,
        });
    }
    if (selector.type !== "all") {
      const files = [
        ...previous.files.filter(
          (file) => !projectReloadScopeMatches(selector, file.relative_path, file.category),
        ),
        ...current.files.filter((file) =>
          projectReloadScopeMatches(selector, file.relative_path, file.category),
        ),
      ].sort(compareScannedFiles);
      this.pendingReload = {
        candidate,
        manifest: {
          project_revision: current.project_revision,
          files,
          compatibility: this.compatibilityValue,
        },
        runtimeManifestSparse: false,
      };
    } else {
      this.pendingReload = { candidate, manifest: current, runtimeManifestSparse: false };
    }
    return {
      base_revision: previous.project_revision,
      target_revision: current.project_revision,
      changes: changes.map(runtimeReloadChange),
    };
  }

  finalizeReload(success: boolean): void {
    const pending = this.pendingReload;
    this.pendingReload = undefined;
    if (!success || !pending) return;
    const candidate = pending.candidate;
    this.revision = pending.manifest.project_revision;
    this.manifestValue = pending.manifest;
    this.pendingSnapshot = undefined;
    this.sourcePayloadsReleased = false;
    this.runtimeManifestSparse = pending.runtimeManifestSparse;
    this.files.clear();
    this.canonicalPaths.clear();
    const activePaths = new Set(
      pending.manifest.files.map((file) => file.relative_path.toLowerCase()),
    );
    for (const [path, handle] of candidate.files) {
      if (activePaths.has(path)) this.files.set(path, handle);
    }
    for (const [path, canonical] of candidate.canonicalPaths) {
      if (activePaths.has(path)) this.canonicalPaths.set(path, canonical);
    }
    const previousResourceIdentities = new Map(this.resourceIdentities);
    this.resourceIdentities.clear();
    for (const file of pending.manifest.files) {
      if (file.category !== "resource") continue;
      const key = file.relative_path.toLowerCase();
      const current = candidate.resourceIdentities.get(key);
      const previous = previousResourceIdentities.get(key);
      const matching =
        current && equalBytes(current.contentHash, file.content_hash) ? current : previous;
      this.resourceIdentities.set(key, {
        contentHash: file.content_hash,
        byteLength: payloadByteLength(file.payload),
        signature:
          matching && equalBytes(matching.contentHash, file.content_hash)
            ? matching.signature
            : undefined,
      });
    }
  }

  hasPendingReload(): boolean {
    return this.pendingReload != null;
  }

  async readResource(relativePath: string): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return new Uint8Array(embedded);
    if (this.usesEmbeddedManifest && this.packagedResourceReader) {
      return this.packagedResourceReader(normalized);
    }
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const current = await handle.getFile();
    const identity = this.resourceIdentities.get(key);
    if (!identity) throw new Error(`资源不在活动项目清单中：${relativePath}`);
    if (current.size !== identity.byteLength)
      throw new Error(`资源长度在项目扫描后发生变化：${relativePath}`);
    if (
      identity.signature != null &&
      `${current.size}:${current.lastModified}` !== identity.signature
    )
      throw new Error(`资源签名在项目扫描后发生变化：${relativePath}`);
    const bytes = new Uint8Array(await current.arrayBuffer());
    if (!equalBytes(blake3(bytes), identity.contentHash))
      throw new Error(`资源内容在项目扫描后发生变化：${relativePath}`);
    return bytes;
  }

  async readResourcePrefix(relativePath: string, maximumBytes: number): Promise<Uint8Array> {
    const normalized = safePath(relativePath);
    const key = normalized.toLowerCase();
    const embedded = this.embeddedResources.get(key);
    if (embedded) return embedded.slice(0, maximumBytes);
    if (this.usesEmbeddedManifest && this.packagedResourceReader) {
      return this.packagedResourceReader(normalized, maximumBytes);
    }
    const handle =
      this.files.get(key) ??
      (await optionalFileHandle(
        this.root,
        (this.canonicalPaths.get(key) ?? normalized).split("/"),
      ));
    if (!handle) throw new Error(`未知资源：${relativePath}`);
    const file = await handle.getFile();
    const identity = this.resourceIdentities.get(key);
    if (!identity) throw new Error(`资源不在活动项目清单中：${relativePath}`);
    if (file.size !== identity.byteLength)
      throw new Error(`资源长度在项目扫描后发生变化：${relativePath}`);
    const signature = `${file.size}:${file.lastModified}`;
    if (identity.signature && signature !== identity.signature)
      throw new Error(`资源在项目扫描后发生变化：${relativePath}`);
    const bytes = new Uint8Array(await file.slice(0, maximumBytes).arrayBuffer());
    const current = await handle.getFile();
    if (`${current.size}:${current.lastModified}` !== signature)
      throw new Error(`资源在项目扫描后发生变化：${relativePath}`);
    if (!identity.signature) identity.signature = signature;
    return bytes;
  }

  fontSources(): ProjectFontSource[] {
    return (this.manifestValue?.files ?? [])
      .filter(
        (file) => file.category === "resource" && isPackagedProjectFontPath(file.relative_path),
      )
      .map((file) => ({
        relativePath: file.relative_path,
        contentHash: new Uint8Array(file.content_hash),
        byteLength: payloadByteLength(file.payload),
        read: () => this.readResource(file.relative_path),
      }));
  }

  async listTraditionalSaveSlots(slotCount: number): Promise<BrowserTraditionalSaveSlot[]> {
    const count = checkedSaveSlotCount(slotCount);
    const directory = await this.root.getDirectoryHandle("sav", { create: true });
    const occupied = new Set<number>();
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const match = /^save(\d{2})\.sav$/i.exec(name);
      if (!match) continue;
      const slot = Number.parseInt(match[1], 10);
      if (slot < count) occupied.add(slot);
    }
    return Array.from({ length: count }, (_, slot) => ({ slot, occupied: occupied.has(slot) }));
  }

  async readTraditionalSave(slot: number): Promise<Uint8Array> {
    const directory = await this.root.getDirectoryHandle("sav");
    const handle = await directory.getFileHandle(saveSlotName(slot));
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async writeTraditionalSave(slot: number, bytes: Uint8Array): Promise<void> {
    const directory = await this.root.getDirectoryHandle("sav", { create: true });
    const handle = await directory.getFileHandle(saveSlotName(slot), { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(bytes as FileSystemWriteChunkType);
    await writable.close();
  }

  async storage(request: any): Promise<any> {
    try {
      const generation = this.manifestValue;
      const result = await dispatchBrowserStorage(
        this.root,
        request.namespace,
        request.relative_path,
        request.operation,
        ["save", "global_save", "resource"].includes(request.namespace)
          ? this.root
          : await this.dataRoot(),
        this.compatibility().profile === "emuera.em",
        request.namespace === "resource" ? this.storageResources() : [],
        this.compatibility().profile === "emuera.skia.snake" ? "nfc_lower" : "literal",
        this.compatibility().profile,
      );
      if (request.namespace === "resource" && generation !== this.manifestValue)
        throw new DOMException("资源项目在读取期间发生变化", "InvalidModificationError");
      return { request_id: request.request_id, result };
    } catch (error) {
      return {
        request_id: request.request_id,
        result: {
          type: "error",
          error: { kind: errorKind(error), message: String(error) },
        },
      };
    }
  }

  private storageResources(): BrowserStorageResource[] {
    const canonical = new Set<string>();
    const resources: BrowserStorageResource[] = [];
    for (const file of this.manifestValue?.files ?? []) {
      if (file.category !== "resource") continue;
      const path = safePath(file.relative_path);
      const canonicalKey = path.toLowerCase();
      if (canonical.has(canonicalKey))
        throw new DOMException("资源清单包含重复规范路径", "DataError");
      canonical.add(canonicalKey);
      // The active manifest authorizes both scanned and embedded resources. Scan identities only
      // contribute change tokens; they cannot supply stale paths or omit packaged-only entries.
      const key = file.relative_path.toLowerCase();
      const byteLength = payloadByteLength(file.payload);
      const observed = this.resourceIdentities.get(key);
      const signature =
        observed?.byteLength === byteLength && equalBytes(observed.contentHash, file.content_hash)
          ? observed.signature
          : undefined;
      const embedded = this.embeddedResources.get(canonicalKey);
      const embeddedManifest = this.usesEmbeddedManifest;
      const packaged = embeddedManifest ? this.packagedResourceReader : undefined;
      const handle = this.files.get(key);
      resources.push({
        path,
        byteLength,
        contentHash: file.content_hash,
        signature,
        open: async () => {
          if (embedded) return embedded;
          if (packaged) {
            if (byteLength > maximumResourceReadBytes)
              throw new DOMException("打包资源超过读取限额", "DataError");
            return packaged(path, maximumResourceReadBytes + 1);
          }
          if (embeddedManifest) throw new DOMException("打包资源没有内嵌字节", "DataError");
          const source = handle ?? (await optionalFileHandle(this.root, path.split("/")));
          if (!source) throw new DOMException("清单资源已被删除", "InvalidModificationError");
          return source.getFile();
        },
      });
    }
    return resources;
  }
}
