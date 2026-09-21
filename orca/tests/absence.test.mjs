import test from 'node:test';
import assert from 'node:assert/strict';
import * as health from '../lib/windows-health.mjs';

function options() {
  const terminal = { handle: 'current', ptyId: 'repo::D:/project@@pty', incarnationId: 'one', tabId: 'current-tab', leafId: 'current-leaf', connected: true, executionHostId: 'local' };
  const desktop = { terminals: [terminal], totalCount: 1, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } };
  const native = { identity: { launchNonce: 'daemon' }, sessions: [{ sessionId: terminal.ptyId, terminalHandle: 'current', incarnationId: 'one', isAlive: true, pid: 10 }] };
  const rows = [{ ProcessId: 10, Name: 'pwsh.exe', CommandLine: 'pwsh', Created: '123' }];
  return { project: 'D:/project', missing: [{ name: 'master', saved: { tabId: 'old', leafId: 'old', session: { id: 'original-id', transcriptPath: 'C:/sessions/original.jsonl' } } }], platform: 'win32', cli: async () => desktop, inventory: async () => native, processes: async () => rows, snapshot: () => ({}), desktop, native, rows };
}

test('native absence requires two matching inventories and process scans', async () => {
  const o = options(); let lists = 0, scans = 0;
  o.inventory = async () => { lists++; return o.native; };
  o.processes = async () => { scans++; return o.rows; };
  assert.equal(await health.verifyWindowsAbsence(o), true);
  assert.equal(lists, 2); assert.equal(scans, 2);
});

test('explicit process session proves identity before Orca hooks are persisted', async () => {
  const o = options();
  o.desktop.terminals[0].agentIdentity = 'pi';
  o.rows.push({ ProcessId: 11, ParentProcessId: 10, Name: 'node.exe', CommandLine: 'node C:/pi-coding-agent/dist/cli.js --session C:/sessions/another.jsonl' });
  assert.equal(await health.verifyWindowsAbsence(o), true);
});

for (const scenario of ['truncated', 'omitted host', 'remote', 'hidden pty', 'wsl', 'changed daemon', 'changed process', 'live session', 'live path', 'unreadable process', 'old pane', 'unbound agent', 'moved conversation']) {
  test(`absence refuses ${scenario}`, async () => {
    const o = options();
    if (scenario === 'truncated') o.desktop.truncated = true;
    if (scenario === 'omitted host') o.desktop.hostScope.omittedHostIds.push('other');
    if (scenario === 'remote') o.desktop.hostScope.hostIds.push('remote');
    if (scenario === 'hidden pty') o.native.sessions.push({ ...o.native.sessions[0], terminalHandle: 'hidden' });
    if (scenario === 'wsl') o.native.sessions[0].wslDistro = 'Ubuntu';
    if (scenario === 'changed daemon') { let n = 0; o.inventory = async () => ({ ...o.native, identity: { launchNonce: String(n++) } }); }
    if (scenario === 'changed process') { let n = 0; o.processes = async () => [{ ...o.rows[0], Created: String(n++) }]; }
    if (scenario === 'live session') o.rows.push({ Name: 'codex.exe', CommandLine: 'codex resume original-id' });
    if (scenario === 'live path') o.rows.push({ Name: 'node.exe', CommandLine: 'pi --session C:\\sessions\\original.jsonl' });
    if (scenario === 'unreadable process') o.rows.push({ Name: 'node.exe', CommandLine: null });
    if (scenario === 'old pane') Object.assign(o.desktop.terminals[0], { tabId: 'old', leafId: 'old' });
    if (scenario === 'unbound agent' || scenario === 'moved conversation') o.desktop.terminals[0].agentIdentity = 'pi';
    if (scenario === 'moved conversation') o.snapshot = () => ({ sleepingAgentSessionsByPaneKey: { 'current-tab:current-leaf': { origin: 'live', worktreeId: 'repo::D:/project', providerSession: { id: 'original-id' } } } });
    await assert.rejects(health.verifyWindowsAbsence(o));
  });
}
