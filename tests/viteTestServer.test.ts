import { describe, expect, it } from "vitest";

import { createLoopbackViteServer, viteServerPort } from "../scripts/vite-test-server.mjs";

describe("Vite test server", () => {
  it("binds an ephemeral loopback port instead of falling back to Vite's default", async () => {
    const server = await createLoopbackViteServer({
      root: process.cwd(),
      logLevel: "silent",
    });
    try {
      const address = server.httpServer?.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe("object");
      if (typeof address !== "object" || address == null) return;
      expect(address.address).toBe("127.0.0.1");
      const port = viteServerPort(server);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(5173);
    } finally {
      await server.close();
    }
  });
});
