import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateAgentsBeforeStart } from '../lib/agent-update.mjs';

const options = (extra = {}) => ({ agents: ['codex', 'pi'], log: () => {},
  processes: async () => [],
  run: async (command, args) => {
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ dependencies: {
      '@openai/codex': { version: '1.0.0' }, '@earendil-works/pi-coding-agent': { version: '1.0.0' },
    } }) };
    if (args[0] === 'view') return { status: 0, stdout: '"1.0.0"' };
    return { status: 0, stdout: '' };
  }, ...extra });

test('active agents across projects defer both program and extension updates', async () => {
  const result = await updateAgentsBeforeStart(options({
    processes: async () => [{ Name: 'codex.exe' }, { Name: 'node.exe', CommandLine: 'node C:/global/pi-coding-agent/dist/bundle/cli.js' }],
    run: async () => { throw new Error('must not touch a running installation'); },
  }));
  assert.deepEqual(result.deferred, ['codex', 'pi']);
  assert.deepEqual(result.updated, []);
});

test('only outdated program packages install; idle Pi extensions update once', async () => {
  const calls = [];
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ run: async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'view' && args[1] === '@openai/codex') return { status: 0, stdout: '"2.0.0"' };
    return defaults.run(command, args);
  } }));
  assert.deepEqual(result.updated, ['codex']);
  assert.equal(calls.filter(row => row[1] === 'install').length, 1);
  assert.deepEqual(calls.find(row => row[1] === 'install').slice(1), ['install', '--global', '@openai/codex@2.0.0']);
  assert.equal(calls.filter(row => row[0] === 'pi' && row[1] === 'update').length, 1);
});

test('failed version lookup warns and keeps startup available', async () => {
  const logs = [];
  const result = await updateAgentsBeforeStart(options({ agents: ['codex'], log: line => logs.push(line),
    run: async () => ({ status: 1, stderr: 'network unavailable' }) }));
  assert.equal(result.warnings.length, 1);
  assert.ok(logs.some(line => line.includes('network unavailable')));
});

test('unreadable process inventory defers updates instead of assuming idle', async () => {
  const result = await updateAgentsBeforeStart(options({ processes: async () => { throw new Error('scan failed'); },
    run: async () => { throw new Error('must not update without evidence'); } }));
  assert.deepEqual(result.deferred, ['codex', 'pi']);
  assert.equal(result.warnings.length, 1);
});

test('an agent appearing after version check prevents its installation', async () => {
  let scans = 0;
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['codex'],
    processes: async () => ++scans === 1 ? [] : [{ Name: 'codex.exe' }],
    run: async (command, args) => {
      if (args[0] === 'view') return { status: 0, stdout: '"2.0.0"' };
      assert.notEqual(args[0], 'install');
      return defaults.run(command, args);
    } }));
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.deferred, ['codex']);
});

test('stops blocking processes, updates, and restores original sessions in order', async () => {
  const calls = [];
  let running = true;
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['pi'],
    processes: async () => running ? [{ Name: 'node.exe', CommandLine: 'pi-coding-agent/dist/cli.js' }] : [],
    lifecycle: {
      stop: async agent => { calls.push(`stop ${agent}`); running = false; return ['original']; },
      resume: async sessions => { assert.deepEqual(sessions, ['original']); calls.push('resume'); running = true; },
    },
    run: async (command, args) => { calls.push(args[0]); return defaults.run(command, args); },
  }));
  assert.deepEqual(result.deferred, []);
  assert.ok(calls.indexOf('stop pi') < calls.indexOf('update'));
  assert.equal(calls.at(-1), 'resume');
});

test('update failure still restores sessions stopped for maintenance', async () => {
  let running = true, resumed = false;
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['pi'],
    processes: async () => running ? [{ Name: 'node.exe', CommandLine: 'pi-coding-agent/dist/cli.js' }] : [],
    lifecycle: {
      stop: async () => { running = false; return ['original']; },
      resume: async () => { resumed = true; },
    },
    run: async (command, args) => args[0] === 'update' ? { status: 1, stderr: 'update failed' } : defaults.run(command, args),
  }));
  assert.equal(resumed, true);
  assert.equal(result.warnings.length, 1);
});

test('external Codex processes do not block updating after managed roles stop', async () => {
  const calls = [];
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['codex'],
    processes: async () => [{ Name: 'codex.exe', ProcessId: 99 }],
    lifecycle: { stop: async () => { calls.push('stop'); return ['managed']; },
      resume: async () => { calls.push('resume'); } },
    run: async (command, args) => {
      calls.push(args[0]);
      if (args[0] === 'view') return { status: 0, stdout: '"2.0.0"' };
      return defaults.run(command, args);
    },
  }));
  assert.deepEqual(result.updated, ['codex']);
  assert.ok(calls.indexOf('stop') < calls.indexOf('install'));
  assert.equal(calls.at(-1), 'resume');
});

test('actual Codex install error is reported and managed roles recover', async () => {
  let resumed = false;
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['codex'],
    processes: async () => [{ Name: 'codex.exe' }],
    lifecycle: { stop: async () => ['managed'], resume: async () => { resumed = true; } },
    run: async (command, args) => args[0] === 'view' ? { status: 0, stdout: '"2.0.0"' } :
      args[0] === 'install' ? { status: 1, stderr: 'EPERM file in use' } : defaults.run(command, args),
  }));
  assert.equal(resumed, true);
  assert.ok(result.warnings[0].includes('EPERM file in use'));
});

test('external Pi does not block program or extension updates after managed roles stop', async () => {
  const calls = [];
  const defaults = options();
  const result = await updateAgentsBeforeStart(options({ agents: ['pi'],
    processes: async () => [{ Name: 'node.exe', CommandLine: 'pi-coding-agent/dist/cli.js' }],
    lifecycle: { stop: async () => { calls.push('stop'); return ['managed']; },
      resume: async () => { calls.push('resume'); } },
    run: async (command, args) => {
      calls.push(args[0]);
      if (args[0] === 'view') return { status: 0, stdout: '"2.0.0"' };
      return defaults.run(command, args);
    },
  }));
  assert.deepEqual(result.updated, ['pi']);
  assert.deepEqual(result.deferred, []);
  assert.equal(result.warnings.length, 0);
  assert.ok(calls.indexOf('stop') < calls.indexOf('install'));
  assert.ok(calls.indexOf('install') < calls.indexOf('update'));
  assert.equal(calls.at(-1), 'resume');
});

test('managed Pi shutdown is checked even when macOS hides its CLI process title', async () => {
  const calls = [], defaults = options();
  await updateAgentsBeforeStart(options({ agents: ['pi'], processes: async () => [{ Name: 'pi' }],
    lifecycle: { stop: async () => { calls.push('stop'); return ['managed']; },
      resume: async () => calls.push('resume') },
    run: async (command, args) => { calls.push(args[0]); return defaults.run(command, args); } }));
  assert.ok(calls.indexOf('stop') < calls.indexOf('update'));
  assert.equal(calls.at(-1), 'resume');
});

test('startup update check is read-only, cached for 24h, and caches failures', async t => {
  const { checkAgentUpdates, clearUpdateCheck } = await import('../lib/agent-update.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-update-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  let clock = Date.parse('2026-10-14T00:00:00Z');
  const run = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'omp') return { status: 0, stdout: 'Current version: 1.0.0\nNew version available: 1.0.1\n' };
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ dependencies: { '@openai/codex': { version: '0.1.0' } } }) };
    return { status: 1, stderr: 'offline' };
  };
  const logs = [];
  const check = () => checkAgentUpdates({ home, agents: ['omp', 'codex', 'omp', 'claude'], run, log: line => logs.push(line), now: () => clock });
  assert.deepEqual(await check(), ['omp']);
  assert.ok(calls.every(call => !/^omp update$|install/.test(call)));
  assert.ok(logs.some(line => /Updates available: omp 1\.0\.0 → 1\.0\.1/.test(line)));
  assert.ok(logs.some(line => /codex update check failed: offline/.test(line)));
  const networkCalls = calls.length;
  clock += 23 * 60 * 60 * 1000;
  assert.deepEqual(await check(), ['omp']);
  assert.equal(calls.length, networkCalls);
  clock += 2 * 60 * 60 * 1000;
  await check();
  assert.ok(calls.length > networkCalls);
  clearUpdateCheck(home);
  assert.equal(fs.existsSync(path.join(home, 'agent-update-check.json')), false);
});

test('CLI usage detection reads full command lines (macOS comm is truncated) on macOS and Windows', async () => {
  const { active, parseProcessRows } = await import('../lib/agent-update.mjs');
  const mac = parseProcessRows([
    'bun /Users/u/.nvm/versions/node/v25/bin/omp --model pay/x --session /Users/u/s.jsonl',
    '/Users/u/.nvm/versions/node/v25/lib/node_modules/bun/bin/bun.exe /Users/u/.nvm/versions/node/v25/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js __omp_worker_daemon_broker',
    'node /Users/u/.nvm/versions/node/v25/bin/codex resume 01a0 --model m',
    '/Users/u/.nvm/versions/node/v25/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex resume 01a0',
    '/bin/zsh -l',
  ].join('\n'));
  assert.equal(mac[2].Name, 'node');
  assert.deepEqual(['omp', 'codex', 'pi'].map(agent => active(mac, agent)), [true, true, false]);
  assert.equal(active(mac.slice(1, 2), 'omp'), true);
  assert.equal(active(mac.slice(2, 3), 'codex'), true);
  const daemonOnly = parseProcessRows('/Users/u/.codex/packages/app-server-daemon/releases/0.162.1-aarch64-apple-darwin/bin/codex app-server daemon');
  assert.equal(active(daemonOnly, 'codex'), false);
  const pi = parseProcessRows('node /Users/u/.nvm/versions/node/v25/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --session a');
  assert.deepEqual(['omp', 'pi'].map(agent => active(pi, agent)), [false, true]);
  const windows = [
    { Name: 'omp.exe', CommandLine: 'C:\\Users\\u\\AppData\\Local\\omp\\omp.exe --session C:\\s.jsonl' },
    { Name: 'codex.exe', CommandLine: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe resume x' },
    { Name: 'node.exe', CommandLine: 'node.exe C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js' },
  ];
  assert.deepEqual(['omp', 'codex', 'pi'].map(agent => active(windows, agent)), [true, true, true]);
});

test('startup auto-update installs only CLIs that no process uses and never stops roles', async t => {
  const { autoUpdateAgents } = await import('../lib/agent-update.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-auto-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const run = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'omp') return { status: 0, stdout: args.includes('--check') ? 'Current version: 1.0.0\nNew version available: 1.0.1\n' : '' };
    if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ dependencies: { '@openai/codex': { version: '0.1.0' } } }) };
    if (args[0] === 'view') return { status: 0, stdout: '"0.2.0"' };
    return { status: 0, stdout: '' };
  };
  const logs = [];
  const busy = [{ Name: 'bun', CommandLine: 'bun /u/bin/omp --session s' }];
  const first = await autoUpdateAgents({ home, agents: ['omp', 'codex'], run, processes: async () => busy, log: line => logs.push(line) });
  assert.deepEqual(first.updated, ['codex']);
  assert.deepEqual(first.deferred, ['omp']);
  assert.ok(calls.includes('npm install --global @openai/codex@0.2.0'));
  assert.ok(!calls.includes('omp update'));
  assert.ok(logs.some(line => /Update postponed for omp: still in use/.test(line)));
  const cache = JSON.parse(fs.readFileSync(path.join(home, 'agent-update-check.json'), 'utf8'));
  assert.equal(cache.agents.codex.current, '0.2.0');
  calls.length = 0;
  const second = await autoUpdateAgents({ home, agents: ['omp', 'codex'], run, processes: async () => [], log: () => {} });
  assert.deepEqual(second.updated, ['omp']);
  assert.ok(calls.includes('omp update') && calls.includes('omp update --plugins'));
  assert.ok(!calls.some(call => call.startsWith('npm view')));
});
