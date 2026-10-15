import { randomUUID } from 'node:crypto';

export function localClaudeTitle(nativeTitle, label) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const activity = clean(nativeTitle).match(/^\s*([^\p{L}\p{N}\s]+)\s+/u)?.[1];
  return `${activity ? activity + ' ' : ''}${clean(label)}`;
}

// A terminal transport only: the existing remote PTY owns Claude and its history.
// Never starts/resumes an agent or retries a possibly delivered keystroke.
export async function connectRemoteTerminal({ pairing, target, WebSocket, nacl, onOutput, onTitle = () => {}, onClose = () => {}, viewport, timeoutMs = 15000 }) {
  const keys = nacl.box.keyPair();
  const key = nacl.box.before(Buffer.from(pairing.publicKeyB64, 'base64'), keys.secretKey);
  const socket = new WebSocket(pairing.endpoint, { handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024 });
  const pending = new Map();
  const client = { id: `orca-team-${randomUUID()}`, type: 'desktop' };
  let state = 'hello', closed = false, subscriptionId, readyResolve, readyReject, authResolve, authReject;
  const authenticated = new Promise((resolve, reject) => { authResolve = resolve; authReject = reject; });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A failed identity check can occur before the caller receives ready.
  ready.catch(() => {});
  const encode = value => {
    const nonce = nacl.randomBytes(24);
    return Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.box.after(Buffer.from(JSON.stringify(value)), nonce, key))]).toString('base64');
  };
  const rejectPending = error => {
    authReject(error); readyReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const close = () => { if (closed) return; closed = true; clearTimeout(authTimer); socket.close(); rejectPending(new Error('Remote terminal connection closed')); };
  const fail = error => { if (closed) return; rejectPending(error); onClose(error); close(); };
  const authTimer = setTimeout(() => fail(new Error('Remote terminal authentication timed out')), timeoutMs);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed || state !== 'ready') return reject(new Error('Remote terminal connection is not ready'));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Remote terminal ${method} outcome unknown; input was not retried`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(encode({ id, deviceToken: pairing.deviceToken, method, params }));
  });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: Buffer.from(keys.publicKey).toString('base64') })));
  socket.on('error', () => fail(new Error('Remote terminal transport failed')));
  socket.on('close', () => { if (!closed) fail(new Error('Remote terminal disconnected; remote session retained')); });
  socket.on('message', (bytes, binary) => {
    try {
      if (binary) throw new Error('Unexpected binary frame on JSON terminal stream');
      let frame;
      if (state === 'hello') {
        frame = JSON.parse(bytes.toString());
        if (frame.type !== 'e2ee_ready') throw new Error('Remote terminal encryption handshake failed');
        state = 'auth';
        socket.send(encode({ type: 'e2ee_auth', deviceToken: pairing.deviceToken, clientCapabilities: [] }));
        return;
      }
      const packed = Buffer.from(bytes.toString(), 'base64');
      const plaintext = nacl.box.open.after(packed.subarray(24), packed.subarray(0, 24), key);
      if (!plaintext) throw new Error('Remote terminal frame authentication failed');
      frame = JSON.parse(Buffer.from(plaintext).toString());
      if (state === 'auth') {
        if (frame.type !== 'e2ee_authenticated') throw new Error('Remote terminal pairing rejected');
        state = 'ready'; clearTimeout(authTimer); authResolve(); return;
      }
      if (frame._keepalive) return;
      if (frame.ok && frame._meta?.runtimeId !== target.runtimeId) throw new Error('Remote runtime identity changed');
      if (frame.id === subscriptionId) {
        if (!frame.ok) throw new Error('Remote terminal subscription rejected');
        const event = frame.result;
        if (event.type === 'scrollback') {
          if (typeof event.serialized !== 'string') throw new Error('Remote terminal has no native screen snapshot');
          onOutput(event.serialized); readyResolve();
        } else if (event.type === 'data') onOutput(event.chunk);
        else if (event.type === 'end') fail(new Error('Remote terminal stream ended; session retained'));
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id); clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(`Remote terminal request refused (${frame.error?.code || 'unknown'})`));
    } catch (error) { fail(error); }
  });
  try {
    await authenticated;
    await request('status.get', {});
    const inspect = async () => {
      const { terminal } = await request('terminal.show', { terminal: target.terminal });
      if (!terminal || terminal.handle !== target.terminal || terminal.incarnationId !== target.incarnation ||
        !terminal.connected || terminal.orphaned || terminal.worktreePath !== target.worktree ||
        (terminal.agentIdentity && terminal.agentIdentity !== 'claude')) throw new Error('Remote terminal identity changed');
      if (terminal.title) onTitle(terminal.title);
      return terminal;
    };
    await inspect();
    subscriptionId = randomUUID();
    socket.send(encode({ id: subscriptionId, deviceToken: pairing.deviceToken, method: 'terminal.subscribe',
      params: { terminal: target.terminal, client, viewport, capabilities: { desktopViewportClaims: 1 } } }));
    const readyTimer = setTimeout(() => fail(new Error('Remote terminal snapshot timed out')), timeoutMs);
    ready.finally(() => clearTimeout(readyTimer)).catch(() => {});
    let inputTail = Promise.resolve();
    return {
      ready, close, inspect,
      send(text) {
        inputTail = inputTail.then(async () => {
          const result = await request('terminal.send', { terminal: target.terminal, text, client, viewport, claimViewport: true });
          if (!result.send?.accepted) throw new Error('Remote input was not accepted; nothing was retried');
        });
        return inputTail;
      },
      resize(next) {
        viewport = { cols: Math.max(20, Math.min(1024, next.cols)), rows: Math.max(8, Math.min(120, next.rows)) };
        return request('terminal.updateViewport', { terminal: target.terminal, client, viewport, claim: true });
      },
    };
  } catch (error) { close(); throw error; }
}
