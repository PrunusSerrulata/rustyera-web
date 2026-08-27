import { serviceLifecycleResourceUrl } from "@/testing/serviceLifecycle";
import type { FrontendBridge } from "@/core/types";

interface ResourceUrlEntry {
  generation: number;
  promise: Promise<string>;
  released: boolean;
  url?: string;
  bytes: number;
  references: number;
}

export interface ResourceUrlLease {
  readonly url: Promise<string>;
  release(): void;
}

export interface ResourceUrlMemoryCounters {
  count: number;
  bytes: number;
  active: { count: number; bytes: number };
  idle: { count: number; bytes: number };
}

/** Own Blob URLs for project generations and revoke them deterministically. */
export class ResourceUrlRegistry {
  private readonly entries = new Map<string, ResourceUrlEntry>();

  acquire(
    bridge: FrontendBridge,
    resourceId: string,
    _revision = 0,
    generation = 0,
  ): ResourceUrlLease {
    void _revision;
    // A project resource is immutable for the lifetime of its project generation. Presentation
    // revisions describe placements, not file revisions; including them here retained one Blob URL
    // per animation frame until the next project reload.
    const key = `${generation}\0${resourceId}`;
    let entry = this.entries.get(key);
    if (!entry)
      entry = {
        generation,
        promise: undefined as unknown as Promise<string>,
        released: false,
        bytes: 0,
        references: 0,
      };
    if (!entry.promise) {
      const created = entry;
      created.promise = bridge
        .readResource(resourceId)
        .then(async (bytes) => {
          const testUrl = await serviceLifecycleResourceUrl(resourceId, bytes, generation);
          if (testUrl) {
            created.bytes = bytes.byteLength;
            return testUrl;
          }
          const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: mediaType(resourceId) }),
          );
          created.url = url;
          created.bytes = bytes.byteLength;
          if (created.released) URL.revokeObjectURL(url);
          return url;
        })
        .catch((error) => {
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw error;
        });
      this.entries.set(key, created);
    }
    entry.references += 1;
    let released = false;
    return {
      url: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry!.references = Math.max(0, entry!.references - 1);
        if (entry!.references === 0 && this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.release(entry!);
        }
      },
    };
  }

  releaseBeforeGeneration(generation: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.generation >= generation) continue;
      this.entries.delete(key);
      this.release(entry);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }

  memoryCounters(): ResourceUrlMemoryCounters {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    const active = { count: this.entries.size, bytes };
    return { count: active.count, bytes: active.bytes, active, idle: { count: 0, bytes: 0 } };
  }

  private release(entry: ResourceUrlEntry): void {
    if (entry.released) return;
    entry.released = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

export const resourceUrlRegistry = new ResourceUrlRegistry();

export function acquireResourceUrl(
  bridge: FrontendBridge,
  resourceId: string,
  revision = 0,
  generation = 0,
): ResourceUrlLease {
  return resourceUrlRegistry.acquire(bridge, resourceId, revision, generation);
}

function mediaType(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    {
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      bmp: "image/bmp",
      wav: "audio/wav",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      opus: "audio/ogg; codecs=opus",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}
