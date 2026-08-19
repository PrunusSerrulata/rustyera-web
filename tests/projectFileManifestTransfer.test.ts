import { expect, it } from "vitest";

import type { BrowserManifest } from "@/platform/browserProject";
import {
  projectFileManifestTransfers,
  runtimeWorkerResultTransfers,
  takeProjectFileManifestOwnership,
} from "@/platform/projectFileManifestTransfer";

it("transfers each embedded resource buffer into one isolated manifest owner", () => {
  const first = Uint8Array.of(1, 2, 3);
  const second = Uint8Array.of(4, 5);
  const manifest: BrowserManifest = {
    project_revision: 1,
    files: [
      {
        relative_path: "resources/first.bin",
        category: "resource",
        payload: { type: "bytes", value: first },
        content_hash: new Uint8Array(32),
      },
      {
        relative_path: "resources/second.bin",
        category: "resource",
        payload: { type: "bytes", value: second },
        content_hash: new Uint8Array(32),
      },
    ],
  };

  expect(projectFileManifestTransfers(manifest)).toEqual([first.buffer, second.buffer]);
  const owned = takeProjectFileManifestOwnership(manifest);

  expect(first.byteLength).toBe(0);
  expect(second.byteLength).toBe(0);
  const firstPayload = owned.files[0].payload;
  const secondPayload = owned.files[1].payload;
  expect(firstPayload.type).toBe("bytes");
  expect(secondPayload.type).toBe("bytes");
  if (firstPayload.type !== "bytes" || secondPayload.type !== "bytes") {
    throw new Error("resource payloads must remain byte arrays after ownership transfer");
  }
  expect(firstPayload.value).toBeInstanceOf(Uint8Array);
  expect(secondPayload.value).toBeInstanceOf(Uint8Array);
  expect(firstPayload.value).toEqual(Uint8Array.of(1, 2, 3));
  expect(secondPayload.value).toEqual(Uint8Array.of(4, 5));
});

it("does not transfer embedded resources on project-file worker responses", () => {
  const resource = Uint8Array.of(7, 8, 9);
  const result = {
    manifest: {
      project_revision: 1,
      files: [
        {
          relative_path: "resources/a.bin",
          category: "resource",
          payload: { type: "bytes", value: resource },
          content_hash: new Uint8Array(32),
        },
      ],
    } satisfies BrowserManifest,
  };

  expect(runtimeWorkerResultTransfers("finishProjectFile", result)).toEqual([]);
  expect(runtimeWorkerResultTransfers("appendProjectFile", result)).toEqual([]);
});
