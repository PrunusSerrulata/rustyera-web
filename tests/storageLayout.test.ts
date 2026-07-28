import { describe, expect, it } from "vitest";

import { storageDirectoryName } from "@/platform/browserProject";

describe("browser storage layout", () => {
  it("uses Emuera's sav directory for both slot and global saves", () => {
    expect(storageDirectoryName("save")).toBe("sav");
    expect(storageDirectoryName("global_save")).toBe("sav");
  });
});
