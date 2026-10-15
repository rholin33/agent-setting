import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connectRemoteTerminal, localClaudeTitle } from '../lib/claude-terminal-client.mjs';
import { terminalDependencies } from '../lib/claude-terminal-dependencies.mjs';

const { nacl, WebSocket } = terminalDependencies();
const { WebSocketServer } = WebSocket;
const target = { runtimeId: 'runtime-a', terminal: 'term-a', incarnation: 'inc-a', worktree: '/remote/control' };
test('local title keeps native activity while labeling any project and role', () => {
  assert.equal(localClaudeTitle('✳ arbitrary-project-review', 'Claude reviewer · Opus'), '✳ Claude reviewer · Opus');
  assert.equal(localClaudeTitle('Other project title', 'Claude designer2 · Opus'), 'Claude designer2 · Opus');
});
test('local title strips terminal control characters from its label', () => {
  assert.equal(localClaudeTitle('', 'Claude master\x07\x1b\n'), 'Claude master');
});
async function fixture(overrides = {}) {
  const serverKeys = nacl.box.keyPair(), calls = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const pairing = { endpoint: `ws://127.0.0.1:${server.address().port}`, publicKeyB64: Buffer.from(serverKeys.publicKey).toString('base64'), deviceToken: 'fixture-only' };
  server.on('connection', socket => {
    let key;
    const send = value => {
      const nonce = nacl.randomBytes(24);
      socket.send(Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.box.after(Buffer.from(JSON.stringify(value)), nonce, key))]).toString('base64'));
    };
    socket.on('message', bytes => {
      if (!key) {
        const hello = JSON.parse(bytes);
        key = nacl.box.before(Buffer.from(hello.publicKeyB64, 'base64'), serverKeys.secretKey);
        socket.send(JSON.stringify({ type: 'e2ee_ready' })); return;
      }
      const packed = Buffer.from(bytes.toString(), 'base64');
      const request = JSON.parse(Buffer.from(nacl.box.open.after(packed.subarray(24), packed.subarray(0, 24), key)));
      if (request.type === 'e2ee_auth') { assert.equal(request.deviceToken, pairing.deviceToken); send({ type: 'e2ee_authenticated' }); return; }
      calls.push(request);
      const respond = result => send({ id: request.id, ok: true, result, _meta: { runtimeId: overrides.runtimeId || target.runtimeId } });
      if (request.method === 'status.get') respond({});
      else if (request.method === 'terminal.show') respond({ terminal: { handle: target.terminal, incarnationId: overrides.incarnation || target.incarnation, connected: true, worktreePath: target.worktree, agentIdentity: 'claude' } });
      else if (request.method === 'terminal.subscribe') {
        respond({ type: 'scrollback', serialized: '\x1b[2JClaude Opus\r\n', cols: 80, rows: 24 });
        respond({ type: 'data', chunk: '\x1b[32mLIVE\x1b[0m' });
      } else if (request.method === 'terminal.send') respond({ send: { accepted: overrides.rejectInput !== true } });
      else respond({ updated: true });
    });
  });
  return { pairing, calls, close: async () => { for (const c of server.clients) c.terminate(); await new Promise(resolve => server.close(resolve)); } };
}

test('attaches to the exact existing remote terminal and forwards real ANSI and input once', async () => {
  const f = await fixture(), output = [];
  const client = await connectRemoteTerminal({ pairing: f.pairing, target, WebSocket, nacl, onOutput: text => output.push(text), viewport: { cols: 80, rows: 24 } });
  try {
    await client.ready;
    assert.equal(output.join(''), '\x1b[2JClaude Opus\r\n\x1b[32mLIVE\x1b[0m');
    await client.send('literal $() `text`\r');
    const writes = f.calls.filter(c => c.method === 'terminal.send');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params.text, 'literal $() `text`\r');
    assert.equal(writes[0].params.terminal, target.terminal);
    assert.ok(!f.calls.some(c => /create|close|launch/.test(c.method)));
  } finally { client.close(); await f.close(); }
});
for (const changed of ['runtimeId', 'incarnation']) {
  test(`refuses a changed ${changed} before subscribing or forwarding any input`, async () => {
    const f = await fixture({ [changed]: 'other' });
    try {
      await assert.rejects(connectRemoteTerminal({ pairing: f.pairing, target, WebSocket, nacl, onOutput() {}, viewport: { cols: 80, rows: 24 } }), /identity/);
      assert.ok(!f.calls.some(c => c.method === 'terminal.send' || c.method === 'terminal.subscribe'));
    } finally { await f.close(); }
  });
}
test('rejected input is reported without resend or remote process restart', async () => {
  const f = await fixture({ rejectInput: true });
  const client = await connectRemoteTerminal({ pairing: f.pairing, target, WebSocket, nacl, onOutput() {}, viewport: { cols: 80, rows: 24 } });
  try {
    await client.ready;
    await assert.rejects(client.send('x'), /not accepted/);
    assert.equal(f.calls.filter(c => c.method === 'terminal.send').length, 1);
  } finally { client.close(); await f.close(); }
});
