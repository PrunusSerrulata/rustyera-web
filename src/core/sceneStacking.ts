import { inject, type InjectionKey } from "vue";

import { serviceInteger, type ServiceInteger } from "@/core/runtimeServiceProtocol";

export type SceneDepthRanks = ReadonlyMap<string, number>;
export type SceneDepthRank = (depth: unknown) => number;

export const sceneDepthRankKey: InjectionKey<SceneDepthRank> = Symbol("scene-depth-rank");

export function sceneDepthKey(depth: unknown): string {
  return String(serviceInteger(depth, "scene depth", true));
}

/** Compact exact i64 depths into CSS ranks around depth-zero text. */
export function compactSceneDepthRanks(depths: Iterable<unknown>): SceneDepthRanks {
  const exact = new Map<string, ServiceInteger>();
  exact.set("0", 0);
  for (const depth of depths) {
    const value = serviceInteger(depth, "scene depth", true);
    exact.set(String(value), value);
  }
  const ordered = [...exact.values()].sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a > b ? -1 : a < b ? 1 : 0;
  });
  const zero = ordered.findIndex((depth) => BigInt(depth) === 0n);
  return new Map(ordered.map((depth, index) => [String(depth), index - zero]));
}

export function useSceneDepthRank(): SceneDepthRank {
  return inject(
    sceneDepthRankKey,
    (depth) => compactSceneDepthRanks([depth]).get(sceneDepthKey(depth)) ?? 0,
  );
}
