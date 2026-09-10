import { describe, expect, it } from "vitest";

import { sameServiceInteger, type ProjectionQueryContext } from "@/core/runtimeServiceProtocol";
import { RuntimeViewportState } from "@/stores/runtimeViewport";

describe("service integer equality", () => {
  it("preserves the validated BigInt comparison for all representation pairs", () => {
    const values: unknown[] = [
      0,
      -0,
      1,
      -1,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      0n,
      1n,
      -1n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MIN_SAFE_INTEGER),
      1n << 64n,
      -(1n << 64n),
      "0",
      "1",
      null,
      undefined,
      true,
      false,
      Symbol("invalid"),
      {},
      {
        valueOf() {
          throw new Error("must not coerce");
        },
      },
    ];
    const valid = (value: unknown): value is number | bigint =>
      typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
    for (const left of values)
      for (const right of values) {
        const expected = valid(left) && valid(right) && BigInt(left) === BigInt(right);
        expect(sameServiceInteger(left, right)).toBe(expected);
      }
  });
});

describe("indexed historical viewport lookup", () => {
  it("keeps historical identities, mixed integer representations, eviction and rejection", async () => {
    let message = 0;
    const viewport = new RuntimeViewportState(async () => ++message);
    for (let revision = 1; revision <= 257; revision++)
      await viewport.observe(
        { width: revision, height: 200, lineColumns: 30, chromeWidth: 0, chromeHeight: 0 },
        true,
        8,
        "",
        `layout-${revision}`,
        "font-one",
      );
    const query = (revision: number | bigint): ProjectionQueryContext => ({
      presentationRevision: 9n,
      environmentRevision: revision,
      projectionSpaceRevision: revision,
    });
    for (const revision of [1, 2, 128, 256, 257, 258])
      for (const key of [revision, BigInt(revision)]) {
        const expected =
          revision >= 2 && revision <= 257 ? { width: revision, height: 200 } : undefined;
        expect(viewport.environment(query(key), 9, "font-one")).toEqual(expected);
        expect(viewport.environment(query(key), 8, "font-one")).toBeUndefined();
        expect(viewport.environment(query(key), 9, "font-two")).toBeUndefined();
        expect(
          viewport.environment({ ...query(key), projectionSpaceRevision: 999 }, 9, "font-one"),
        ).toBeUndefined();
        const diagnostic = JSON.parse(
          viewport.describeEnvironmentMismatch(query(key), 9, undefined, "font-one"),
        );
        expect(diagnostic.observation).toEqual(
          expected ? { ...expected, environmentStyleIdentity: "font-one" } : null,
        );
      }
    const invalid: unknown[] = [
      "2",
      true,
      null,
      undefined,
      NaN,
      Infinity,
      2.5,
      Number.MAX_SAFE_INTEGER + 1,
      1n << 80n,
    ];
    for (const key of invalid) {
      const context = query(key as number | bigint);
      expect(viewport.environment(context, 9, "font-one")).toBeUndefined();
      expect(
        JSON.parse(viewport.describeEnvironmentMismatch(context, 9, undefined, "font-one"))
          .observation,
      ).toBeNull();
      const invalidProjection = {
        ...query(2),
        projectionSpaceRevision: key,
      } as ProjectionQueryContext;
      expect(viewport.environment(invalidProjection, 9, "font-one")).toBeUndefined();
      expect(
        JSON.parse(
          viewport.describeEnvironmentMismatch(invalidProjection, 9, undefined, "font-one"),
        ).observation,
      ).toBeNull();
    }
    for (const [environmentRevision, projectionSpaceRevision] of [
      [2, 2n],
      [2n, 2],
    ] as const)
      expect(
        viewport.environment(
          { presentationRevision: 9, environmentRevision, projectionSpaceRevision },
          9n,
          "font-one",
        ),
      ).toEqual({ width: 2, height: 200 });
    viewport.reject("128");
    expect(viewport.environment(query(128n), 9, "font-one")).toBeUndefined();
    expect(
      JSON.parse(viewport.describeEnvironmentMismatch(query(128n), 9, undefined, "font-one"))
        .observation,
    ).toBeNull();
    expect(viewport.environment(query(127), 9, "font-one")).toEqual({ width: 127, height: 200 });
    viewport.reset();
    expect(viewport.environment(query(257), 9, "font-one")).toBeUndefined();
    expect(
      JSON.parse(viewport.describeEnvironmentMismatch(query(257), 9, undefined, "font-one"))
        .observation,
    ).toBeNull();
  });

  it("keeps only valid historical observations across asynchronous lifecycle boundaries", async () => {
    const gates: { resolve(value: number): void; reject(error: Error): void }[] = [];
    const viewport = new RuntimeViewportState(
      () => new Promise<number>((resolve, reject) => gates.push({ resolve, reject })),
    );
    const observe = (width: number) =>
      viewport.observe(
        { width, height: 200, lineColumns: 30, chromeWidth: 0, chromeHeight: 0 },
        true,
        8,
        "",
        `layout-${width}`,
        "font-one",
      );
    const check = (revision: number, width?: number) => {
      const query = {
        presentationRevision: 9n,
        environmentRevision: BigInt(revision),
        projectionSpaceRevision: revision,
      };
      expect(viewport.environment(query, 9, "font-one")).toEqual(
        width == null ? undefined : { width, height: 200 },
      );
      for (const [published, style] of [
        [9, "font-one"],
        [8, "font-two"],
      ] as const) {
        const measurement = { width: 400, height: 300 };
        expect(
          JSON.parse(viewport.describeEnvironmentMismatch(query, published, measurement, style)),
        ).toEqual({
          expected: {
            presentationRevision: "9",
            environmentRevision: String(revision),
            projectionSpaceRevision: String(revision),
          },
          publishedPresentationRevision: String(published),
          measurement,
          observation:
            width == null ? null : { width, height: 200, environmentStyleIdentity: "font-one" },
          environmentStyleIdentity: style,
        });
      }
      const mismatch = { ...query, projectionSpaceRevision: 999 };
      expect(viewport.environment(mismatch, 9, "font-one")).toBeUndefined();
      expect(
        JSON.parse(viewport.describeEnvironmentMismatch(mismatch, 9, undefined, "font-one"))
          .observation,
      ).toBeNull();
    };
    const first = observe(100);
    check(1);
    gates[0].resolve(1);
    await first;
    check(1, 100);
    const second = observe(200);
    const third = observe(300);
    check(1, 100);
    check(2);
    check(3);
    gates[2].resolve(3);
    await third;
    check(3, 300);
    check(1, 100);
    gates[1].resolve(2);
    await second;
    check(2, 200);
    const rejected = observe(400);
    viewport.reject("4");
    gates[3].resolve(4);
    await rejected;
    check(4);
    check(3, 300);
    const failed = observe(500).then(
      () => null,
      (error: unknown) => error,
    );
    const stale = observe(600);
    const failure = new Error("transport failure");
    gates[4].reject(failure);
    expect(await failed).toBe(failure);
    for (const revision of [1, 2, 3, 5, 6]) check(revision);
    gates[5].resolve(6);
    await stale;
    check(6);
    const recovered = observe(700);
    gates[6].resolve(7);
    await recovered;
    check(7, 700);
    const old = observe(800);
    viewport.reset();
    check(7);
    const fresh = observe(900);
    check(1);
    gates[8].resolve(9);
    await fresh;
    check(1, 900);
    gates[7].resolve(8);
    await old;
    check(8);
    check(1, 900);
  });
});
