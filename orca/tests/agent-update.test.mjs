import test from 'node:test';
import assert from 'node:assert/strict';
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
