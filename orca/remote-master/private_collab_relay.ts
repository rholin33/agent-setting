/** Private native OMP relay; opaque payloads use a uint32 big-endian peer prefix.
 * Wire contract: can1357/oh-my-pi packages/collab-web/src/lib/link.ts and
 * packages/collab-web/scripts/local-relay.ts. No room key reaches this service.
 * Run: bun private_collab_relay.ts --config /private/relay.json (owner mode 0600).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";

export interface RelayConfig {
  bind: string;
  port: number;
  peers: string[];
  token_sha256: string;
}
export interface PrivateRelay { url: string; stop(): void }
export const LIMITS = Object.freeze({ rooms: 64, guests: 16, frameBytes: 8 * 1024 * 1024 });
const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
interface SocketData { roomId: string; role: "host" | "guest"; peerId: number }
type Socket = Bun.ServerWebSocket<SocketData>;
interface Room { host: Socket; guests: Map<number, Socket>; nextPeerId: number }

function tailnetIP(value: unknown): value is string {
  if (typeof value !== "string" || !isIPv4(value)) return false;
  const parts = value.split(".").map(Number);
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}
export function validateConfig(value: unknown): RelayConfig {
  if (!value || typeof value !== "object") throw new Error("invalid relay configuration");
  const c = value as RelayConfig;
  if (!tailnetIP(c.bind) || !Number.isInteger(c.port) || c.port < 0 || c.port > 65535 ||
      !Array.isArray(c.peers) || c.peers.length === 0 || c.peers.length > 32 ||
      !c.peers.every(tailnetIP) || typeof c.token_sha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(c.token_sha256)) throw new Error("invalid relay configuration");
  return { bind: c.bind, port: c.port, peers: [...c.peers], token_sha256: c.token_sha256 };
}

function readConfig(path: string): RelayConfig {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 16384) {
      throw new Error("configuration must be a private owner-owned file");
    }
    return validateConfig(JSON.parse(readFileSync(fd, "utf8")));
  } finally { closeSync(fd); }
}

export function startRelay(input: RelayConfig): PrivateRelay {
  const config = validateConfig(input);
  const peers = new Set(config.peers);
  const digest = Buffer.from(config.token_sha256, "hex");
  const rooms = new Map<string, Room>();
  let stopped = false;

  function send(ws: Socket, message: string | Buffer): boolean {
    // A negative send result means Bun buffered the message: terminate instead
    // of accumulating a queue. Bun's own cap also bounds its native buffer.
    if (ws.readyState !== 1 || ws.getBufferedAmount() > 0) {
      detach(ws);
      ws.terminate();
      return false;
    }
    if (ws.send(message) <= 0) {
      detach(ws);
      ws.terminate();
      return false;
    }
    return true;
  }
  function detach(ws: Socket): void {
    const room = rooms.get(ws.data.roomId);
    if (!room) return;
    if (ws.data.role === "host") {
      // A rejected duplicate host never owns (and cannot destroy) this room.
      if (room.host !== ws) return;
      rooms.delete(ws.data.roomId);
      for (const guest of room.guests.values()) {
        if (send(guest, '{"t":"room-closed"}')) guest.close(4001, "room closed");
      }
      room.guests.clear();
    } else if (room.guests.get(ws.data.peerId) === ws) {
      room.guests.delete(ws.data.peerId);
      send(room.host, JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
    }
  }

  const server = Bun.serve<SocketData>({
    hostname: config.bind,
    port: config.port,
    maxRequestBodySize: 0,
    idleTimeout: 15,
    fetch(req, srv) {
      const source = srv.requestIP(req)?.address.replace(/^::ffff:/, "");
      if (!source || !peers.has(source)) return new Response("forbidden", { status: 403 });
      const auth = req.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(auth);
      const candidate = createHash("sha256").update(match?.[1] ?? "").digest();
      const accepted = timingSafeEqual(candidate, digest);
      if (!accepted || !match) return new Response("unauthorized", { status: 401 });
      const url = new URL(req.url);
      const room = ROOM_PATH.exec(url.pathname);
      const role = url.searchParams.get("role");
      if (req.method !== "GET" || !room || (role !== "host" && role !== "guest") ||
          [...url.searchParams.keys()].some(key => key !== "role") || url.searchParams.getAll("role").length !== 1) {
        return new Response("not found", { status: 404 });
      }
      if (srv.upgrade(req, { data: { roomId: room[1]!, role, peerId: 0 } })) return;
      return new Response("websocket upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: LIMITS.frameBytes,
      backpressureLimit: LIMITS.frameBytes,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        const { roomId, role } = ws.data;
        if (role === "host") {
          if (rooms.has(roomId)) { ws.close(4009, "host already connected"); return; }
          if (rooms.size >= LIMITS.rooms) { ws.close(4008, "room limit"); return; }
          rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
          return;
        }
        const room = rooms.get(roomId);
        if (!room) { ws.close(4004, "no such room"); return; }
        if (room.guests.size >= LIMITS.guests || room.nextPeerId > 0xffffffff) {
          ws.close(4008, "guest limit"); return;
        }
        ws.data.peerId = room.nextPeerId++;
        room.guests.set(ws.data.peerId, ws);
        send(room.host, JSON.stringify({ t: "peer-joined", peer: ws.data.peerId }));
      },
      message(ws, message) {
        if (typeof message === "string" || message.byteLength < 4) return;
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        if (ws.data.role === "host") {
          if (room.host !== ws) return;
          const peer = message.readUInt32BE(0);
          if (peer === 0) {
            for (const guest of room.guests.values()) send(guest, message);
          } else {
            const guest = room.guests.get(peer);
            if (guest) send(guest, message);
          }
        } else if (room.guests.get(ws.data.peerId) === ws) {
          message.writeUInt32BE(ws.data.peerId, 0);
          send(room.host, message);
        }
      },
      close(ws) { detach(ws); },
    },
    error() { return new Response("relay error", { status: 500 }); },
  });
  return {
    url: `ws://${config.bind}:${server.port}`,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const room of rooms.values()) {
        detach(room.host);
        room.host.close(1001, "relay stopping");
      }
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--config") throw new Error("invalid arguments");
    const relay = startRelay(readConfig(args[1]!));
    const stop = () => { relay.stop(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log("private collab relay ready");
  } catch {
    console.error("private collab relay failed; check private configuration and Tailscale binding");
    process.exit(1);
  }
}
