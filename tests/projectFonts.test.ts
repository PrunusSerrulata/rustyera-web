import { blake3 } from "@noble/hashes/blake3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectFontRegistry, parseProjectFont } from "@/platform/projectFonts";
import { sfntFont } from "./fontFixture";

class FontFaceMock {
  static created: FontFaceMock[] = [];
  readonly load = vi.fn(async () => this);

  constructor(
    readonly family: string,
    readonly source: ArrayBuffer,
    readonly descriptors: FontFaceDescriptors,
  ) {
    FontFaceMock.created.push(this);
  }
}

describe("project font registration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FontFaceMock.created = [];
    Reflect.deleteProperty(document, "fonts");
  });

  it("reads localized family aliases and face matching descriptors", () => {
    const font = sfntFont(
      [
        { nameId: 1, value: "Era Mono SC" },
        { nameId: 1, value: "等距时代黑体 SC" },
        { nameId: 16, value: "ERA ゴシック" },
      ],
      { weight: 700, width: 3, italic: true },
    );

    expect(parseProjectFont(font)).toEqual({
      families: ["ERA ゴシック", "Era Mono SC", "等距时代黑体 SC"],
      descriptors: { weight: "700", stretch: "condensed", style: "italic" },
    });
  });

  it("registers every valid alias from one shared buffer and removes old project faces", async () => {
    const added: FontFaceMock[] = [];
    const deleted: FontFaceMock[] = [];
    vi.stubGlobal("FontFace", FontFaceMock);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: FontFaceMock) => added.push(face),
        delete: (face: FontFaceMock) => {
          deleted.push(face);
          return true;
        },
      },
    });
    const registry = new ProjectFontRegistry();
    const firstBytes = sfntFont([
      { nameId: 1, value: "Shared Font" },
      { nameId: 1, value: "共享字体" },
    ]);
    const secondBytes = sfntFont([{ nameId: 1, value: "New Font" }]);

    const first = await registry.replace([source("font/Project.ttf", firstBytes)]);
    const second = await registry.replace([source("font/New.ttf", secondBytes)]);

    expect(first).toEqual({ fonts: ["Shared Font", "共享字体"], errors: [] });
    expect(second).toEqual({ fonts: ["New Font"], errors: [] });
    expect(added.map((face) => face.family)).toEqual(["Shared Font", "共享字体", "New Font"]);
    expect(FontFaceMock.created[0]?.source).toBe(FontFaceMock.created[1]?.source);
    expect(deleted.map((face) => face.family)).toEqual(["Shared Font", "共享字体"]);
  });

  it("reuses unchanged path-and-hash font registrations without rereading bytes", async () => {
    vi.stubGlobal("FontFace", FontFaceMock);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn(() => true) },
    });
    const bytes = sfntFont([{ nameId: 1, value: "Stable Font" }]);
    const stable = source("font/Stable.ttf", bytes);
    const registry = new ProjectFontRegistry();

    const first = await registry.replace([stable]);
    const second = await registry.replace([stable]);

    expect(second).toEqual(first);
    expect(stable.read).toHaveBeenCalledOnce();
    expect(FontFaceMock.created).toHaveLength(1);
  });

  it("rejects an oversized authoritative length before reading the font", async () => {
    const oversized = source("font/Huge.ttf", new Uint8Array());
    oversized.byteLength = 16 * 1024 * 1024 + 1;

    const result = await new ProjectFontRegistry().replace([oversized]);

    expect(result.errors).toEqual([expect.stringContaining("字体文件超过 16 MiB")]);
    expect(oversized.read).not.toHaveBeenCalled();
  });

  it("retries a path-and-hash identity after a transient read failure", async () => {
    vi.stubGlobal("FontFace", FontFaceMock);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn(() => true) },
    });
    const bytes = sfntFont([{ nameId: 1, value: "Retry Font" }]);
    const font = source("font/Retry.ttf", bytes);
    font.read.mockRejectedValueOnce(new Error("temporary failure"));
    const registry = new ProjectFontRegistry();

    expect((await registry.replace([font])).errors).toHaveLength(1);
    expect((await registry.replace([font])).fonts).toEqual(["Retry Font"]);
    expect(font.read).toHaveBeenCalledTimes(2);
  });

  it("isolates malformed, changed, and unsupported files without retaining old faces", async () => {
    const added: FontFaceMock[] = [];
    const deleted: FontFaceMock[] = [];
    vi.stubGlobal("FontFace", FontFaceMock);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: FontFaceMock) => added.push(face),
        delete: (face: FontFaceMock) => {
          deleted.push(face);
          return true;
        },
      },
    });
    const registry = new ProjectFontRegistry();
    const old = sfntFont([{ nameId: 1, value: "Old Font" }]);
    await registry.replace([source("font/Old.ttf", old)]);
    const valid = sfntFont([{ nameId: 1, value: "Valid Font" }]);
    const changed = source("font/Changed.ttf", valid);
    changed.contentHash = new Uint8Array(32);

    const result = await registry.replace([
      source("font/Broken.ttf", Uint8Array.of(1, 2, 3)),
      changed,
      source("font/Web.woff2", Uint8Array.of(4, 5, 6)),
      source("font/Valid.ttf", valid),
    ]);

    expect(result.fonts).toEqual(["Valid Font"]);
    expect(result.errors).toEqual([
      expect.stringContaining("font/Broken.ttf：字体文件过短"),
      expect.stringContaining("font/Changed.ttf：字体在项目扫描后发生变化"),
      expect.stringContaining("font/Web.woff2：该字体格式会打包"),
    ]);
    expect(deleted.map((face) => face.family)).toContain("Old Font");
    expect(added.map((face) => face.family)).toContain("Valid Font");
  });

  it("rejects name strings outside the declared name table and skips Mac encodings", () => {
    const outside = sfntFont([{ nameId: 1, value: "Outside" }]);
    const view = new DataView(outside.buffer);
    view.setUint32(24, 18);
    expect(() => parseProjectFont(outside)).toThrow("name 表字符串越界");

    const macOnly = sfntFont([{ nameId: 1, value: "Mac Name", platform: 1 }]);
    expect(() => parseProjectFont(macOnly)).toThrow("不包含可用 family");
  });
});

function source(relativePath: string, bytes: Uint8Array) {
  return {
    relativePath,
    contentHash: blake3(bytes),
    byteLength: bytes.byteLength,
    read: vi.fn(async () => new Uint8Array(bytes)),
  };
}
