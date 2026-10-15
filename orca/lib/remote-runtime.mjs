import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirectory } from './platform.mjs';

// 已配对远端 Orca 的连接信息只从本机 environment 注册表取得；按 id 或名称取唯一项，并在给定时核对 runtimeId。
export function pairedEnvironment(environment, { runtimeId, directory = dataDirectory() } = {}) {
  const file = path.join(directory, 'orca-environments.json');
  if (!fs.existsSync(file)) throw new Error('No paired remote Orca environment on this machine');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  // 未指定时只接受唯一的已配对环境，与 OMP 适配器的发现规则一致。
  const matches = (registry.environments || []).filter(env => !environment || env.id === environment || env.name === environment);
  if (matches.length !== 1) throw new Error(environment ? `Paired environment ${environment} not found` : 'Select exactly one paired remote environment (--environment)');
  if (runtimeId && matches[0].runtimeId !== runtimeId) throw new Error('Paired environment identity changed');
  const env = matches[0];
  const pairing = env.endpoints.find(endpoint => endpoint.id === env.preferredEndpointId) || env.endpoints[0];
  if (!pairing || pairing.kind !== 'websocket') throw new Error('No paired terminal endpoint');
  return { env, pairing };
}

// Orca 配对的端到端加密 RPC 通道。请求超时视为结果未知，绝不自动重发。
// 不属于任何待决请求的帧（例如订阅事件）交给 onFrame。
export async function openRuntimeConnection({ pairing, runtimeId, WebSocket, nacl, timeoutMs = 15000, onFrame = () => {}, onClose = () => {} }) {
  const keys = nacl.box.keyPair();
  const key = nacl.box.before(Buffer.from(pairing.publicKeyB64, 'base64'), keys.secretKey);
  const socket = new WebSocket(pairing.endpoint, { handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024 });
  const pending = new Map();
  let state = 'hello', closed = false, authResolve, authReject;
  const authenticated = new Promise((resolve, reject) => { authResolve = resolve; authReject = reject; });
  const encode = value => {
    const nonce = nacl.randomBytes(24);
    return Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.box.after(Buffer.from(JSON.stringify(value)), nonce, key))]).toString('base64');
  };
  const rejectPending = error => {
    authReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const close = () => { if (closed) return; closed = true; clearTimeout(authTimer); socket.close(); rejectPending(new Error('Remote terminal connection closed')); };
  const fail = error => { if (closed) return; rejectPending(error); onClose(error); close(); };
  const authTimer = setTimeout(() => fail(new Error('Remote terminal authentication timed out')), timeoutMs);
  const post = (id, method, params) => socket.send(encode({ id, deviceToken: pairing.deviceToken, method, params }));
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed || state !== 'ready') return reject(new Error('Remote terminal connection is not ready'));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Remote terminal ${method} outcome unknown; input was not retried`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    post(id, method, params);
  });
  const subscribe = (method, params) => { const id = randomUUID(); post(id, method, params); return id; };
  socket.on('open', () => socket.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: Buffer.from(keys.publicKey).toString('base64') })));
  socket.on('error', () => fail(new Error('Remote terminal transport failed')));
  socket.on('close', () => { if (!closed) fail(new Error('Remote terminal disconnected; remote session retained')); });
  socket.on('message', (bytes, binary) => {
    try {
      if (binary) throw new Error('Unexpected binary frame on JSON terminal stream');
      if (state === 'hello') {
        if (JSON.parse(bytes.toString()).type !== 'e2ee_ready') throw new Error('Remote terminal encryption handshake failed');
        state = 'auth';
        socket.send(encode({ type: 'e2ee_auth', deviceToken: pairing.deviceToken, clientCapabilities: [] }));
        return;
      }
      const packed = Buffer.from(bytes.toString(), 'base64');
      const plaintext = nacl.box.open.after(packed.subarray(24), packed.subarray(0, 24), key);
      if (!plaintext) throw new Error('Remote terminal frame authentication failed');
      const frame = JSON.parse(Buffer.from(plaintext).toString());
      if (state === 'auth') {
        if (frame.type !== 'e2ee_authenticated') throw new Error('Remote terminal pairing rejected');
        state = 'ready'; clearTimeout(authTimer); authResolve(); return;
      }
      if (frame._keepalive) return;
      if (frame.ok && frame._meta?.runtimeId !== runtimeId) throw new Error('Remote runtime identity changed');
      const waiting = pending.get(frame.id);
      if (!waiting) { onFrame(frame); return; }
      pending.delete(frame.id); clearTimeout(waiting.timer);
      if (frame.ok) waiting.resolve(frame.result);
      else waiting.reject(new Error(`Remote terminal request refused (${frame.error?.code || 'unknown'})${frame.error?.message ? `: ${frame.error.message}` : ''}`));
    } catch (error) { fail(error); }
  });
  await authenticated;
  return { request, subscribe, close, fail };
}
