import { describe, expect, it } from "vitest";

import { responsiveColumnGroupLayout } from "@/core/columnLayout";

describe("responsive PRINTC column layout", () => {
  const cells = Array.from({ length: 12 }, () => 25);

  it("shrinks five columns before reducing the column count", () => {
    expect(responsiveColumnGroupLayout(119, cells)).toEqual({ columnWidth: 23, columns: 5 });
    expect(responsiveColumnGroupLayout(100, cells)).toEqual({ columnWidth: 20, columns: 5 });
    expect(responsiveColumnGroupLayout(79, cells)).toEqual({ columnWidth: 19, columns: 4 });
  });

  it("keeps the maximum width and adds columns on wide viewports", () => {
    expect(responsiveColumnGroupLayout(120, cells)).toEqual({ columnWidth: 24, columns: 5 });
    expect(responsiveColumnGroupLayout(144, cells)).toEqual({ columnWidth: 24, columns: 6 });
  });

  it("never makes the grid wider than an exceptionally narrow viewport", () => {
    expect(responsiveColumnGroupLayout(15, cells)).toEqual({ columnWidth: 15, columns: 1 });
  });
});
