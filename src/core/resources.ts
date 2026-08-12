import type { FrontendBridge } from "@/core/types";

const cache = new Map<string, Promise<string>>();

export function resourceUrl(
  bridge: FrontendBridge,
  resourceId: string,
  revision = 0,
  generation = 0,
): Promise<string> {
  const key = `${resourceId}\0${generation}\0${revision}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const value = bridge
    .readResource(resourceId)
    .then((bytes) =>
      URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType(resourceId) })),
    )
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, value);
  return value;
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
