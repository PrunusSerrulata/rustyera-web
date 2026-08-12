import { createServer as createTcpServer } from "node:net";

import { createServer as createViteServer } from "vite";

const LOOPBACK_HOST = "127.0.0.1";

export async function createLoopbackViteServer(options) {
  const port = await findAvailableLoopbackPort();
  const server = await createViteServer({
    ...options,
    server: {
      ...options.server,
      host: LOOPBACK_HOST,
      port,
      strictPort: true,
    },
  });
  try {
    await server.listen();
    return server;
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

export function viteServerPort(server) {
  const address = server.httpServer?.address();
  if (typeof address !== "object" || address == null) {
    throw new Error("Vite test server did not bind a TCP port");
  }
  return address.port;
}

async function findAvailableLoopbackPort() {
  const probe = createTcpServer();
  probe.unref();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, resolve);
  });
  const address = probe.address();
  if (typeof address !== "object" || address == null) {
    probe.close();
    throw new Error("test port probe did not bind a TCP port");
  }
  await new Promise((resolve, reject) =>
    probe.close((error) => (error == null ? resolve() : reject(error))),
  );
  return address.port;
}
