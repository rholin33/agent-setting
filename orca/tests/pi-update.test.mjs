import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updatePiBeforeStart, runPiUpdate } from '../lib/pi-update.mjs';
import { projectFiles, saveJson } from '../lib/team.mjs';

test('Windows Pi update supports cmd and both PowerShell editions', () => {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { status: 0 }; };
  assert.equal(runPiUpdate('pi.cmd', ['update', '--all'], 'win32', spawn, 'cmd.exe').status, 0);
  assert.equal(calls[0][0].toLowerCase().endsWith('cmd.exe'), true);
  assert.deepEqual(calls[0][1], ['/d', '/s', '/c', 'pi.cmd update --all']);
  assert.equal(calls[0][2].windowsHide, true);
  for (const shell of ['powershell.exe', 'pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
    runPiUpdate('pi.cmd', ['update', '--all'], 'win32', spawn, shell);
    const [command, args, options] = calls.at(-1);
    assert.equal(command, shell);
    assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& pi.cmd update --all; exit $LASTEXITCODE']);
    assert.equal(options.windowsHide, true);
  }
  assert.throws(() => runPiUpdate('pi.cmd', ['update', '--all'], 'win32', spawn, 'bash.exe'), /Unsupported Windows update shell/);
  assert.throws(() => runPiUpdate('pi.cmd', ['update', '--all; echo bad'], 'win32', spawn, 'pwsh.exe'), /Unexpected Pi update command/);
  runPiUpdate('pi', ['update', '--all'], 'linux', spawn);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['pi', ['update', '--all']]);
});

test('Pi update is deferred for live project Pi panes and runs before first launch', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pi-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  const files = projectFiles(home, project);
  fs.mkdirSync(files.directory, { recursive: true });
  saveJson(path.join(home, 'team.json'), [
    { name: 'master', agent: 'pi' }, { name: 'loader', agent: 'pi' }, { name: 'coder1', agent: 'codex' },
  ]);
  saveJson(files.state, { agents: {
    master: { tabId: 'tab', leafId: 'master', session: { id: 'original' } },
    loader: { tabId: 'tab', leafId: 'loader', session: { id: 'other' } },
  } });
  const calls = [];
  const options = {
    home, project, names: ['master', 'loader', 'coder1'], snapshot: () => ({}), log: () => {},
    cli: async () => ({ terminals: [{ tabId: 'tab', leafId: 'master', worktreePath: project, connected: true }] }),
    run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'changed 9 packages\nUpdated packages\nUpdated pi from 0.84.4 to 0.87.1' }; },
  };
  assert.deepEqual(await updatePiBeforeStart(options), { updated: false, restarted: [] });
  assert.deepEqual(calls, []);
  options.cli = async () => ({ terminals: [] });
  assert.deepEqual(await updatePiBeforeStart(options), { updated: true, restarted: [] });
  assert.deepEqual(calls, [[process.platform === 'win32' ? 'pi.cmd' : 'pi', 'update', '--all']]);
  calls.length = 0;
  assert.deepEqual(await updatePiBeforeStart({ ...options, run: () => ({ status: 0, stdout: 'up to date, audited 42 packages\nUpdated packages' }) }),
    { updated: false, restarted: [] });
  assert.deepEqual(calls, []);
  await assert.rejects(updatePiBeforeStart({ ...options, run: () => ({ status: 1, stderr: 'update failed' }) }), /update failed/);
  assert.deepEqual(calls, []);
});
