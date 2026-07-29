import { describe, expect, it } from "vitest";

import {
  cacheIdentityManifest,
  decodeProtocolBytes,
  decodeProjectSource,
  normalizeResourceManifest,
  runBounded,
} from "../src/platform/browserProject";

describe("browser project source decoding", () => {
  it("decodes UTF-8 and removes its byte order mark", () => {
    expect(
      decodeProjectSource(new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xbd, 0xa0]), "main.erb"),
    ).toBe("你");
  });

  it("normalizes Windows-31J source text", () => {
    const bytes = new Uint8Array([0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x2c, 0x31, 0x0a]);

    expect(decodeProjectSource(bytes, "GAMEBASE.csv")).toBe("コード,1\n");
  });

  it("normalizes GBK source text after Windows-31J rejects it", () => {
    const bytes = new Uint8Array([0x3b, 0xbd, 0xd7, 0xb2, 0xe3, 0x0a]);

    expect(decodeProjectSource(bytes, "main.erh")).toBe(";阶层\n");
  });

  it("reports source text invalid in every supported encoding", () => {
    expect(() => decodeProjectSource(new Uint8Array([0x81]), "main.erb")).toThrow(
      "main.erb 不是有效的 UTF-8、Windows-31J 或 GBK 文件",
    );
  });
});

describe("browser storage byte decoding", () => {
  it("accepts BigInt arrays projected by WASM", () => {
    expect(decodeProtocolBytes(BigUint64Array.from([0n, 127n, 255n]))).toEqual(
      Uint8Array.of(0, 127, 255),
    );
  });

  it("rejects values outside the byte range", () => {
    expect(() => decodeProtocolBytes(BigUint64Array.from([256n]))).toThrow("存储操作包含无效字节");
  });
});

describe("browser resource manifest normalization", () => {
  it("normalizes resource paths to NFC while preserving spacing and line endings", () => {
    expect(normalizeResourceManifest("FACE,  e\u0301.png  \r\nANIM,Anime\n")).toBe(
      "FACE,  é.png  \r\nANIM,Anime\n",
    );
  });
});

describe("browser project reads", () => {
  it("limits concurrency and reports failures in file order", async () => {
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 12 }, (_, index) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      if (index === 5 || index === 9) throw new Error(`failed-${index}`);
    });

    await expect(runBounded(tasks, 3)).rejects.toThrow("failed-5");
    expect(maximum).toBe(3);
  });
});

describe("browser compiled cache identity", () => {
  it("keeps paths, categories, and hashes without cloning project payloads", () => {
    const hash = new Uint8Array(32).fill(7);
    const manifest = {
      project_revision: 7,
      files: [
        {
          relative_path: "ERB/main.erb",
          category: "erb",
          payload: { type: "utf8" as const, value: "@SYSTEM_TITLE\nRETURN" },
          content_hash: hash,
        },
      ],
    };

    expect(cacheIdentityManifest(manifest)).toEqual({
      project_revision: 7,
      files: [
        {
          relative_path: "ERB/main.erb",
          category: "erb",
          payload: { type: "utf8", value: "" },
          content_hash: hash,
        },
      ],
    });
  });
});
