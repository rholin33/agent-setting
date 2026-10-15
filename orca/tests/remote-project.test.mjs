import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteProject, localProjectName, remoteProjectPath } from '../lib/remote-project.mjs';
import { pairedEnvironment } from '../lib/remote-runtime.mjs';

const env = { id: 'env-1', name: 'studio', runtimeId: 'runtime-1', preferredEndpointId: 'ep', endpoints: [{ id: 'ep', kind: 'websocket', endpoint: 'ws://x' }] };
const registry = () => ({ env, pairing: env.endpoints[0] });
const cli = repos => async args => { assert.deepEqual(args, ['repo', 'list']); return { repos }; };

function remote({ home, flavor, created }) {
  const calls = [];
  let closed = false;
  const connect = async ({ runtimeId }) => {
    assert.equal(runtimeId, env.runtimeId);
    return {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'files.browseServerDir') return { resolvedPath: home, pathFlavor: flavor, entries: [] };
        if (method === 'repo.create') return created(params);
        throw new Error(`unexpected ${method}`);
      },
      close: () => { closed = true; },
    };
  };
  return { calls, connect, closed: () => closed };
}

test('remote project path follows the remote host path flavor', () => {
  assert.equal(remoteProjectPath('/Users/gs', 'IDT', 'posix'), '/Users/gs/Code/orca-remote/IDT');
  assert.equal(remoteProjectPath('/home/dev', 'IDT', 'posix'), '/home/dev/Code/orca-remote/IDT');
  assert.equal(remoteProjectPath('C:\\Users\\dev', 'IDT', 'win32'), 'C:\\Users\\dev\\Code\\orca-remote\\IDT');
  assert.throws(() => remoteProjectPath('/x', 'IDT', undefined), /path flavor/);
});

test('creates the remote project named after the caller Orca project (macOS host)', async () => {
  const project = fs.realpathSync(os.tmpdir());
  const r = remote({ home: '/Users/gs', flavor: 'posix', created: ({ parentPath, name }) => ({ repo: { id: 'repo-9', path: `${parentPath}/${name}` } }) });
  const result = await ensureRemoteProject({ environment: 'studio', project, cli: cli([{ path: project, displayName: 'industrial-drawing-translator' }]),
    connect: r.connect, dependencies: () => ({}), registry });
  assert.deepEqual(r.calls[1], { method: 'repo.create', params: { parentPath: '/Users/gs/Code/orca-remote', name: 'industrial-drawing-translator', kind: 'git' } });
  assert.deepEqual(result, { environment: 'studio', environmentId: 'env-1', runtimeId: 'runtime-1', name: 'industrial-drawing-translator',
    path: '/Users/gs/Code/orca-remote/industrial-drawing-translator', repoId: 'repo-9' });
  assert.equal(r.closed(), true);
});

test('Windows host uses its own home and separators', async () => {
  const project = fs.realpathSync(os.tmpdir());
  const r = remote({ home: 'C:\\Users\\dev', flavor: 'win32', created: ({ parentPath, name }) => ({ repo: { id: 'w', path: `${parentPath}\\${name}` } }) });
  const result = await ensureRemoteProject({ project, cli: cli([{ path: project, displayName: 'Revisited' }]), connect: r.connect, dependencies: () => ({}), registry });
  assert.equal(r.calls[1].params.parentPath, 'C:\\Users\\dev\\Code\\orca-remote');
  assert.equal(result.path, 'C:\\Users\\dev\\Code\\orca-remote\\Revisited');
});

test('a non-empty unregistered folder is reported, never replaced by another directory', async () => {
  const project = fs.realpathSync(os.tmpdir());
  const r = remote({ home: '/Users/gs', flavor: 'posix', created: () => ({ error: '"P" already exists at this location and is not empty.' }) });
  await assert.rejects(ensureRemoteProject({ project, cli: cli([{ path: project, displayName: 'P' }]), connect: r.connect, dependencies: () => ({}), registry }), /not empty/);
  assert.equal(r.calls.filter(call => call.method === 'repo.create').length, 1);
  assert.equal(r.closed(), true);
});

test('caller project must be a unique registered Orca project with a folder-safe name', async () => {
  const project = fs.realpathSync(os.tmpdir());
  await assert.rejects(localProjectName({ project, cli: cli([]) }), /not a unique Orca project/);
  await assert.rejects(localProjectName({ project, cli: cli([{ path: project, displayName: 'a/b' }]) }), /cannot be used/);
  assert.equal(await localProjectName({ project, cli: cli([{ path: project, displayName: '' }]) }), path.basename(project));
});

test('pairing lookup needs one explicit or unique environment and a matching runtime', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = environments => fs.writeFileSync(path.join(directory, 'orca-environments.json'), JSON.stringify({ environments }));
  write([env]);
  assert.equal(pairedEnvironment(undefined, { directory }).env.id, 'env-1');
  assert.equal(pairedEnvironment('studio', { directory, runtimeId: 'runtime-1' }).pairing.id, 'ep');
  assert.throws(() => pairedEnvironment('env-1', { directory, runtimeId: 'other' }), /identity changed/);
  write([env, { ...env, id: 'env-2', name: 'laptop' }]);
  assert.throws(() => pairedEnvironment(undefined, { directory }), /exactly one/);
  assert.throws(() => pairedEnvironment('missing', { directory }), /not found/);
});
