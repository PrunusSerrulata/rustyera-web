import { referenceCompatibility } from "./compatibilityTestSupport";
import { expect, it } from "vitest";

import type { BrowserManifest } from "@/platform/browserProject";
import {
  normalizeProjectFileIdentity,
  normalizeProjectFileManifest,
  projectFileManifestTransfers,
  runtimeWorkerResultTransfers,
  takeProjectFileManifestOwnership,
} from "@/platform/projectFileManifestTransfer";

it("normalizes actual exported UTF-8 byte lengths and rejects incomplete identity records", () => {
  const file = {
    relativePath: "csv/GAMEBASE.CSV",
    category: "csv",
    contentHash: "a".repeat(64),
    payloadKind: "utf8",
    byteLength: 80n,
  };
  expect(normalizeProjectFileIdentity({ projectRevision: 1n, files: [file] })).toEqual({
    projectRevision: 1,
    files: [{ ...file, byteLength: 80 }],
  });
  expect(() => normalizeProjectFileIdentity({ projectRevision: 1, files: [file, file] })).toThrow(
    "重复",
  );
  expect(() =>
    normalizeProjectFileIdentity({
      projectRevision: 1,
      files: [{ ...file, byteLength: undefined }],
    }),
  ).toThrow("字节长度");
  expect(() =>
    normalizeProjectFileIdentity({
      projectRevision: 1,
      files: [{ ...file, payloadKind: "external_resource" }],
    }),
  ).toThrow("内容无效");
});

it("normalizes the WASM project-file projection into browser-owned resource descriptors", () => {
  const manifest = normalizeProjectFileManifest({
    project_revision: 7,
    compatibility: referenceCompatibility(),
    files: [
      {
        relative_path: "resources/1.webp",
        category: "resource",
        payload: {
          type: "external_resource",
          value: {
            byte_length: 123,
            image_metadata: { width: 10, height: 20, format: "webp", animated: false },
          },
        },
        content_hash: Array.from({ length: 32 }, (_, index) => index),
      },
    ],
  });

  expect(manifest).toEqual({
    project_revision: 7,
    compatibility: referenceCompatibility(),
    files: [
      {
        relative_path: "resources/1.webp",
        category: "resource",
        payload: {
          type: "external",
          byteLength: 123,
          imageMetadata: { width: 10, height: 20, format: "webp", animated: false },
        },
        content_hash: Uint8Array.from({ length: 32 }, (_, index) => index),
      },
    ],
  });
});

it.each([
  [
    "unknown payload",
    { type: "mystery", value: "" },
    new Uint8Array(32),
    "resources/1.webp 的 payload 类型无效",
  ],
  ["missing descriptor", { type: "external_resource" }, new Uint8Array(32), "外部资源描述"],
  [
    "negative resource length",
    { type: "external_resource", value: { byte_length: -1, image_metadata: null } },
    new Uint8Array(32),
    "资源长度 不是非负安全整数",
  ],
  [
    "short hash",
    { type: "bytes", value: Uint8Array.of(1) },
    Uint8Array.of(1, 2, 3),
    "内容哈希 长度必须为 32 字节",
  ],
  [
    "unknown image format",
    {
      type: "external_resource",
      value: {
        byte_length: 1,
        image_metadata: { width: 1, height: 1, format: "unknown", animated: false },
      },
    },
    new Uint8Array(32),
    "图片元数据无效",
  ],
])("rejects malformed WASM project-file manifests: %s", (_name, payload, hash, message) => {
  expect(() =>
    normalizeProjectFileManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "resources/1.webp",
          category: "resource",
          payload,
          content_hash: hash,
        },
      ],
    }),
  ).toThrow(message);
});

it("rejects missing file arrays and unknown project-file categories", () => {
  expect(() => normalizeProjectFileManifest({ project_revision: 1 })).toThrow("files 不是数组");
  expect(() =>
    normalizeProjectFileManifest({
      project_revision: 1,
      compatibility: referenceCompatibility(),
      files: [
        {
          relative_path: "resources/1.webp",
          category: "unknown",
          payload: { type: "bytes", value: Uint8Array.of(1) },
          content_hash: new Uint8Array(32),
        },
      ],
    }),
  ).toThrow("resources/1.webp 的类别无效");
});

it("transfers each embedded resource buffer into one isolated manifest owner", () => {
  const first = Uint8Array.of(1, 2, 3);
  const second = Uint8Array.of(4, 5);
  const manifest: BrowserManifest = {
    project_revision: 1,
    compatibility: referenceCompatibility(),
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
      compatibility: referenceCompatibility(),
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

it.each(["als", "erd"])("preserves %s in packaged-project Worker manifests", (category) => {
  const manifest = normalizeProjectFileManifest({
    project_revision: 2,
    compatibility: referenceCompatibility(),
    files: [
      {
        relative_path: `ERB/BUFF.${category}`,
        category,
        payload: { type: "utf8", value: "10,主名\n" },
        content_hash: new Uint8Array(32),
      },
    ],
  });
  const owned = takeProjectFileManifestOwnership(manifest).files[0];
  expect(owned.relative_path).toBe(`ERB/BUFF.${category}`);
  expect(owned.category).toBe(category);
  expect(owned.payload).toEqual({ type: "utf8", value: "10,主名\n" });
  // structuredClone can return typed arrays from another realm in the DOM test host.
  expect(Array.from(owned.content_hash)).toEqual(Array.from(manifest.files[0].content_hash));
});
