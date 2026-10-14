import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LIMITS, startRelay, validateConfig, type PrivateRelay } from "./private_collab_relay";

// Uses an explicitly configured real tailnet interface, never a public listener.
// COLLAB_TEST_BIND=<local-tailnet-ip> bun test private_collab_relay.test.ts
const bind = process.env.COLLAB_TEST_BIND ?? "127.0.0.1";
const token = "test-only-private-relay-bearer-0123456789";
const config = { bind, port: 0, peers: [bind], token_sha256: createHash("sha256").update(token).digest("hex") };
const relays: PrivateRelay[] = [];
const sockets: WebSocket[] = [];
const room = "native_omp_room_123";
function relay(peers = [bind]) {
  const result = startRelay({ ...config, peers });
  relays.push(result);
  return result;
}
function connect(url: string, role: "host" | "guest", roomId = room) {
  const ws = new WebSocket(`${url}/r/${roomId}?role=${role}`, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(ws);
  ws.binaryType = "arraybuffer";
  const queued: (string | ArrayBuffer)[] = [];
  const waiters: ((data: string | ArrayBuffer) => void)[] = [];
  ws.onmessage = event => {
    const waiter = waiters.shift();
    if (waiter) waiter(event.data); else queued.push(event.data);
  };
  const closed = Promise.withResolvers<CloseEvent>();
  ws.onclose = closed.resolve;
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.reject(new Error("websocket failed"));
  return {
    ws, opened: opened.promise, closed: closed.promise,
    next: () => {
      if (queued.length) return Promise.resolve(queued.shift()!);
      const pending = Promise.withResolvers<string | ArrayBuffer>();
      waiters.push(pending.resolve);
      return pending.promise;
    },
  };
}
function frame(peer: number, body: string): Buffer {
  const message = Buffer.alloc(4 + Buffer.byteLength(body));
  message.writeUInt32BE(peer, 0);
  message.write(body, 4);
  return message;
}
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const service of relays.splice(0)) service.stop();
});

describe.skipIf(!process.env.COLLAB_TEST_BIND)("private native relay", () => {
  test("rejects public/loopback binding and non-tailnet allowlists", () => {
    for (const address of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "localhost", "100.128.0.1"]) {
      expect(() => validateConfig({ ...config, bind: address })).toThrow();
      expect(() => validateConfig({ ...config, peers: [address] })).toThrow();
    }
  });
  test("authenticates every HTTP request before routing or upgrade", async () => {
    const service = relay();
    const url = service.url.replace("ws:", "http:") + `/r/${room}?role=host`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${"x".repeat(40)}` } })).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(426);
    expect((await fetch(service.url.replace("ws:", "http:") + "/")).status).toBe(401);
  });
  test("denies a peer despite valid bearer and spoofed forwarding headers", async () => {
    const denied = bind === "100.64.0.1" ? "100.64.0.2" : "100.64.0.1";
    const service = relay([denied]);
    const response = await fetch(service.url.replace("ws:", "http:") + `/r/${room}?role=host`, {
      headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": denied },
    });
    expect(response.status).toBe(403);
  });
  test("routes big-endian targeted/broadcast frames and rewrites guest identity", async () => {
    const service = relay();
    const host = connect(service.url, "host");
    await host.opened;
    const first = connect(service.url, "guest");
    await first.opened;
    expect(JSON.parse(await host.next() as string)).toEqual({ t: "peer-joined", peer: 1 });
    const second = connect(service.url, "guest");
    await second.opened;
    expect(JSON.parse(await host.next() as string)).toEqual({ t: "peer-joined", peer: 2 });
    host.ws.send(frame(1, "target"));
    host.ws.send(frame(0, "broadcast"));
    expect(Buffer.from(await first.next() as ArrayBuffer)).toEqual(frame(1, "target"));
    expect(Buffer.from(await first.next() as ArrayBuffer)).toEqual(frame(0, "broadcast"));
    expect(Buffer.from(await second.next() as ArrayBuffer)).toEqual(frame(0, "broadcast"));
    second.ws.send(frame(999, "opaque ciphertext"));
    expect(Buffer.from(await host.next() as ArrayBuffer)).toEqual(frame(2, "opaque ciphertext"));
    second.ws.close();
    expect(JSON.parse(await host.next() as string)).toEqual({ t: "peer-left", peer: 2 });
  });
  test("duplicate host cannot destroy original; host closure notifies guests", async () => {
    const service = relay();
    const host = connect(service.url, "host");
    await host.opened;
    const duplicate = connect(service.url, "host");
    await duplicate.opened;
    expect((await duplicate.closed).code).toBe(4009);
    const guest = connect(service.url, "guest");
    await guest.opened;
    expect(JSON.parse(await host.next() as string).t).toBe("peer-joined");
    host.ws.send(frame(0, "still alive"));
    expect(Buffer.from(await guest.next() as ArrayBuffer)).toEqual(frame(0, "still alive"));
    host.ws.close();
    expect(JSON.parse(await guest.next() as string)).toEqual({ t: "room-closed" });
    expect((await guest.closed).code).toBe(4001);
    const late = connect(service.url, "guest");
    await late.opened;
    expect((await late.closed).code).toBe(4004);
  });
  test("bounds guest admission without evicting existing guests", async () => {
    const service = relay();
    const host = connect(service.url, "host");
    await host.opened;
    for (let peer = 1; peer <= LIMITS.guests; peer++) {
      await connect(service.url, "guest").opened;
      expect(JSON.parse(await host.next() as string)).toEqual({ t: "peer-joined", peer });
    }
    const extra = connect(service.url, "guest");
    await extra.opened;
    expect((await extra.closed).code).toBe(4008);
  });
  test("rejects oversized binary messages", async () => {
    const service = relay();
    const host = connect(service.url, "host");
    await host.opened;
    host.ws.send(Buffer.alloc(LIMITS.frameBytes + 1));
    expect((await host.closed).code).not.toBe(1000);
  });
});
