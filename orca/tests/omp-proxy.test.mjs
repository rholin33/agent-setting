import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchArguments } from '../lib/sessions.mjs';
import { agentCommand } from '../lib/platform.mjs';

const registry = (enabled = '0x1', server = '127.0.0.1:10808') =>
  `    ProxyEnable    REG_DWORD    ${enabled}\r\n    ProxyServer    REG_SZ    ${server}\r\n`;
const launch = (options = {}, agent = 'omp', session = null, project = os.tmpdir()) =>
  launchArguments({ agent, model: 'pay/gpt-6-astra' }, 'prompt.md', session, project, os.tmpdir(), {
    ompProxyOptions: { platform: 'win32', env: {}, run: () => registry(), ...options },
  });

test('OMP launch picks up the enabled Windows system proxy without mutating parent env', () => {
  const env = { NO_PROXY: 'localhost,internal.example' };
  assert.equal(launch({ env }).env.PI_PROXY, 'http://127.0.0.1:10808');
  assert.deepEqual(env, { NO_PROXY: 'localhost,internal.example' });
});

test('each launch reads current system settings, including proxy changes and disablement', () => {
  let output = registry();
  const options = { run: () => output };
  assert.equal(launch(options).env.PI_PROXY, 'http://127.0.0.1:10808');
  output = registry('0x1', 'localhost:7890');
  assert.equal(launch(options).env.PI_PROXY, 'http://localhost:7890');
  output = registry('0x0');
  assert.equal(launch(options).env.PI_PROXY, undefined);
});

test('protocol-specific Windows proxy prefers HTTPS and falls back to HTTP', () => {
  assert.equal(launch({ run: () => registry('0x1', 'http=localhost:8080;https=localhost:8443;socks=localhost:1080') }).env.PI_PROXY, 'http://localhost:8443');
  assert.equal(launch({ run: () => registry('0x1', 'http=localhost:8080') }).env.PI_PROXY, 'http://localhost:8080');
  assert.equal(launch({ run: () => registry('0x1', 'https=https://proxy.example:8443') }).env.PI_PROXY, 'https://proxy.example:8443');
});

test('explicit proxy environment retains priority without reading system settings', () => {
  for (const key of ['PI_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const env = { [key]: 'http://explicit.example:8888' };
    const result = launch({ env, run: () => assert.fail('must not read registry') });
    assert.equal(result.env.PI_PROXY, undefined, key);
    assert.equal(env[key], 'http://explicit.example:8888');
  }
});

test('provider-specific proxy and bypass remain available when adding system fallback', () => {
  const env = { PI_PROXY_PAY: 'http://provider.example:8888', NO_PROXY: 'internal.example' };
  const child = { ...env, ...launch({ env }).env };
  assert.equal(child.PI_PROXY_PAY, env.PI_PROXY_PAY);
  assert.equal(child.NO_PROXY, env.NO_PROXY);
  assert.equal(child.PI_PROXY, 'http://127.0.0.1:10808');
});

test('missing, unsupported or malformed system settings do not inject a proxy', () => {
  for (const output of ['', registry('0x0'), registry('0x1', ''), registry('0x1', 'socks=localhost:1080'), registry('0x1', 'file:///tmp/proxy'), registry('0x1', 'bad proxy'), registry('0x1', 'http://proxy/path')]) {
    assert.equal(launch({ run: () => output }).env.PI_PROXY, undefined, output);
  }
  assert.equal(launch({ run: () => { throw new Error('registry unavailable'); } }).env.PI_PROXY, undefined);
});

test('non-Windows launches and other runtimes do not query Windows proxy settings', () => {
  const run = () => assert.fail('unexpected registry query');
  for (const platform of ['linux', 'darwin']) assert.equal(launch({ platform, run }).env.PI_PROXY, undefined);
  for (const agent of ['pi', 'claude']) assert.equal(launch({ run }, agent).env.PI_PROXY, undefined);
});

test('exact-session OMP resume gets proxy while preserving session and model', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-proxy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'original', cwd: directory }) + '\n');
  const result = launch({}, 'omp', { id: 'original', transcriptPath }, directory);
  assert.equal(result.env.PI_PROXY, 'http://127.0.0.1:10808');
  assert.equal(result.args[result.args.indexOf('--session') + 1], transcriptPath);
  assert.equal(result.args[result.args.indexOf('--model') + 1], 'pay/gpt-6-astra');
});

test('Windows wrapper passes the detected proxy to the actual child process', { skip: process.platform !== 'win32' }, () => {
  const { executable, args } = agentCommand(process.execPath, ['-p', 'process.env.PI_PROXY']);
  const result = execFileSync(executable, args, { env: { ...process.env, ...launch().env }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.trim(), 'http://127.0.0.1:10808');
});
