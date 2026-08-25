import type { FrontendBridge } from "@/core/types";

interface ResourceUrlEntry {
  generation: number;
  promise: Promise<string>;
  released: boolean;
  url?: string;
  bytes: number;
}

export interface ResourceUrlMemoryCounters {
  count: number;
  bytes: number;
}

/** Own Blob URLs for project generations and revoke them deterministically. */
export class ResourceUrlRegistry {
  private readonly entries = new Map<string, ResourceUrlEntry>();

  resourceUrl(
    bridge: FrontendBridge,
    resourceId: string,
    revision = 0,
    generation = 0,
  ): Promise<string> {
    const key = `${resourceId}\0${generation}\0${revision}`;
    const cached = this.entries.get(key);
    if (cached) return cached.promise;
    const entry: ResourceUrlEntry = {
      generation,
      promise: undefined as unknown as Promise<string>,
      released: false,
      bytes: 0,
    };
    entry.promise = bridge
      .readResource(resourceId)
      .then((bytes) => {
        const url = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: mediaType(resourceId) }),
        );
        entry.url = url;
        entry.bytes = bytes.byteLength;
        if (entry.released) URL.revokeObjectURL(url);
        return url;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, entry);
    return entry.promise;
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
    return { count: this.entries.size, bytes };
  }

  private release(entry: ResourceUrlEntry): void {
    if (entry.released) return;
    entry.released = true;
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

export const resourceUrlRegistry = new ResourceUrlRegistry();

export function resourceUrl(
  bridge: FrontendBridge,
  resourceId: string,
  revision = 0,
  generation = 0,
): Promise<string> {
  return resourceUrlRegistry.resourceUrl(bridge, resourceId, revision, generation);
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
