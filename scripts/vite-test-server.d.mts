import type { ViteDevServer } from "vite";

export function createLoopbackViteServer(
  options: Parameters<typeof import("vite").createServer>[0],
): Promise<ViteDevServer>;

export function viteServerPort(server: ViteDevServer): number;
