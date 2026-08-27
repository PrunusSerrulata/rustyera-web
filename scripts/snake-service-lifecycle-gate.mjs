import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** A real, bounded PNG stream. The gate delays bytes, never a decoded image/service value. */
export async function createLifecycleImageGate(project) {
  const source = path.join(await realpath(project), "resources/lifecycle-gate.png");
  if ((await realpath(source)) !== source)
    throw new Error("lifecycle resource path must not traverse symlinks");
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("lifecycle gate requires a bounded regular fixture PNG");
  const bytes = await readFile(source);
  if (
    bytes.length !== info.size ||
    bytes.length < 34 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
    bytes.readUInt32BE(16) < 1 ||
    bytes.readUInt32BE(16) > 64 ||
    bytes.readUInt32BE(20) < 1 ||
    bytes.readUInt32BE(20) > 64
  )
    throw new Error("lifecycle image must be a PNG of at most 64 by 64 pixels");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const events = [];
  let active;
  const sockets = new Set();
  const record = (event) => {
    if (events.length >= 32) throw new Error("lifecycle gate event limit");
    events.push({ index: events.length, ...event });
  };
  const server = createServer((request, response) => {
    if (
      !active ||
      request.method !== "GET" ||
      request.url !== active.pathname ||
      active.requested
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    active.requested = true;
    const current = active;
    current.response = response;
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    // Only signature+IHDR are delivered: there are no IDAT pixels to decode yet.
    response.write(bytes.subarray(0, 33));
    record({ type: "image_prefix_sent", token: current.token, bytes: 33, sha256 });
    response.on("close", () => {
      current.closed = true;
      record({ type: "image_connection_closed", token: current.token, released: current.released });
    });
    response.setTimeout(15_000, () => {
      current.timedOut = true;
      response.destroy(new Error("bounded lifecycle image stream expired"));
    });
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    source,
    sha256,
    byteLength: bytes.length,
    arm(label) {
      if (active && !active.released)
        throw new Error("prior lifecycle image gate was not released");
      const token = randomBytes(32).toString("hex");
      active = {
        token,
        pathname: `/snake-lifecycle/${token}.png`,
        requested: false,
        released: false,
        closed: false,
        timedOut: false,
      };
      record({ type: "armed", label, token, source, sha256, bytes: bytes.length });
      return {
        resourceId: "resources/lifecycle-gate.png",
        sha256,
        byteLength: bytes.length,
        url: `${origin}${active.pathname}`,
      };
    },
    status() {
      return {
        requested: active?.requested ?? false,
        released: active?.released ?? false,
        closed: active?.closed ?? false,
        timedOut: active?.timedOut ?? false,
        events: structuredClone(events),
      };
    },
    release() {
      if (!active?.requested || active.released || active.closed || active.timedOut)
        throw new Error("lifecycle gate was not physically pending at release");
      active.released = true;
      record({
        type: "image_remaining_bytes_released",
        token: active.token,
        bytes: bytes.length - 33,
      });
      active.response.end(bytes.subarray(33));
    },
    async close() {
      if (active?.response && !active.response.writableEnded) active.response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
