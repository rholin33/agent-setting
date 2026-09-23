import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartRole } from '../lib/restart.mjs';
import { initialize, readJson, saveJson } from '../lib/team.mjs';
import { normalizeProject } from '../lib/platform.mjs';

for (const provider of ['pi', 'codex']) test(`restart reconciles verified pending ${provider} conversation before exit`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-pending-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'archi', agent: provider, model: 'model' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'archi', agents: ['archi'] }] });
  const files = await initialize(home, project);
  const transcriptPath = path.join(home, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify(provider === 'pi'
    ? { type: 'session', id: 'original', cwd: project }
    : { type: 'session_meta', payload: { id: 'original', cwd: project } }) + '\n');
  const terminal = { handle: 'h', incarnationId: 'i', tabId: 't', leafId: 'l', connected: true, worktreePath: project };
  saveJson(files.state, { workspace: project, agents: { archi: { agent: provider, pending: true, tabId: 't', leafId: 'l', launchIntent: { transcriptPath } } } });
  let sends = 0;
  const options = { home, project, role: 'archi', focus: async () => {}, sleep: async () => {}, log: () => {},
    snapshot: async () => ({ sleepingAgentSessionsByPaneKey: { 't:l': { agent: provider, worktreeId: `local::${project}`, providerSession: { id: 'original', transcriptPath } } } }),
    inspect: async () => ({ kind: 'agent', terminal, sessionPaths: provider === 'pi' ? [transcriptPath] : [], sessionIds: provider === 'codex' ? ['original'] : [] }),
    cli: async args => {
      if (args[1] === 'list') return { terminals: [terminal] };
      if (args[1] === 'wait') return { wait: { satisfied: false } };
      if (args[1] === 'send') sends++;
      throw new Error(`Unexpected terminal operation: ${args[1]}`);
    } };
  await assert.rejects(restartRole(options), /busy/);
  assert.equal(sends, 0);
  assert.equal(readJson(files.state).agents.archi.pending, undefined);
  assert.equal(readJson(files.state).agents.archi.session.id, 'original');
  saveJson(files.state, { workspace: project, agents: { archi: { agent: provider, pending: true, tabId: 't', leafId: 'l', launchIntent: { transcriptPath } } } });
  await assert.rejects(restartRole({ ...options, snapshot: async () => ({}), inspect: async () => ({ kind: 'agent', terminal, sessionPaths: [], sessionIds: [] }) }), /cannot be verified/);
  assert.equal(readJson(files.state).agents.archi.session, undefined);
  assert.equal(readJson(files.state).agents.archi.pending, true);
  assert.equal(sends, 0);
  await assert.rejects(restartRole({ ...options, snapshot: async () => ({ sleepingAgentSessionsByPaneKey: { 't:l': { agent: provider, worktreeId: `local::${project}`, providerSession: { id: 'original', transcriptPath: `${transcriptPath}.other` } } } }) }), /cannot be verified/);
  assert.equal(readJson(files.state).agents.archi.session, undefined);
  assert.equal(sends, 0);
});

test('restart waits briefly for a pending session binding and never exits before verification', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-binding-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'archi', agent: 'pi', model: 'model' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'archi', agents: ['archi'] }] });
  const files = await initialize(home, project);
  const transcriptPath = path.join(home, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'original', cwd: project }) + '\n');
  saveJson(files.state, { workspace: project, agents: { archi: { agent: 'pi', pending: true, tabId: 't', leafId: 'l', launchIntent: { transcriptPath } } } });
  const terminal = { handle: 'h', incarnationId: 'i', tabId: 't', leafId: 'l', connected: true, worktreePath: project };
  let snapshots = 0;
  const options = { home, project, role: 'archi', log: () => {}, focus: async () => {}, sleep: async () => {},
    cli: async args => {
      if (args[1] === 'list') return { terminals: [terminal] };
      if (args[1] === 'wait') return { wait: { satisfied: false } };
      throw new Error(`Unexpected terminal operation: ${args[1]}`);
    },
    inspect: async () => ({ kind: 'agent', terminal, sessionPaths: [], sessionIds: [] }),
    snapshot: async () => ++snapshots < 3 ? {} : { sleepingAgentSessionsByPaneKey: { 't:l': { agent: 'pi', worktreeId: `local::${project}`, providerSession: { id: 'original', transcriptPath } } } } };
  await assert.rejects(restartRole(options), /busy/);
  assert.equal(snapshots, 4);
  assert.equal(readJson(files.state).agents.archi.session.id, 'original');
});

for (const provider of ['pi', 'codex']) for (const mode of ['ok', 'busy', 'ambiguous', 'changed']) {
  test(`restart ${provider}: ${mode}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-team-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const project = normalizeProject(home);
    saveJson(path.join(home, 'team.json'), [{ name: 'archi', agent: provider, model: 'model' }]);
    saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'archi', agents: ['archi'] }] });
    const files = await initialize(home, project);
    const transcriptPath = path.join(home, 'original.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify(provider === 'pi' ? { type: 'session', id: 'original', cwd: project } : { type: 'session_meta', payload: { id: 'original', cwd: project } }) + '\n');
    const state = readJson(files.state);
    state.agents.archi = { agent: provider, model: 'model', tabId: 't', leafId: 'l', session: { id: 'original', transcriptPath } };
    state.agents.sibling = { session: { id: 'untouched' } };
    saveJson(files.state, state);
    const terminal = { handle: 'h', incarnationId: 'i', tabId: 't', leafId: 'l', connected: true, worktreePath: project };
    let phase = 'agent'; const sends = []; let focused = false;
    const options = { home, project, role: 'archi', focus: async () => { focused = true; }, snapshot: () => ({}), log: () => {}, sleep: async () => {},
      inspect: async () => ({ kind: phase, terminal, sessionPaths: provider === 'pi' ? [mode === 'changed' ? 'other' : transcriptPath] : [], sessionIds: provider === 'codex' ? [mode === 'changed' ? 'other' : 'original'] : [] }),
      cli: async args => {
        const verb = args[1];
        if (verb === 'list') return { terminals: [terminal] };
        if (verb === 'wait') { assert.equal(focused, true); }
        if (verb === 'wait') return { wait: { satisfied: mode !== 'busy' } };
        if (verb === 'read') return { terminal: { source: 'screen', draft: null, tail: ['PS C:\\project>'] } };
        if (verb === 'send') {
          sends.push(args);
          assert.equal(args[3], 'h');
          if (sends.length === 1) {
            assert.equal(args[5], '\u0015\u000b');
            return { send: { accepted: true } };
          }
          if (sends.length === 2) {
            assert.equal(args[5], '/quit');
            assert.deepEqual(args.slice(-2), ['--wait-submit', '5']);
            assert.equal(readJson(files.state).agents.archi.restartIntent.sessionId, 'original');
            if (mode === 'ambiguous') throw new Error('transport ambiguous');
            phase = 'shell';
          } else phase = 'agent';
          return { send: { accepted: true } };
        }
        assert.fail(`Unexpected ${verb}`);
      } };
    if (mode === 'ok') {
      await restartRole(options);
      const after = readJson(files.state);
      assert.equal(sends.length, 3);
      assert.equal(after.agents.archi.session.id, 'original');
      assert.equal(after.agents.archi.restartIntent, undefined);
      assert.equal(after.agents.archi.pending, undefined);
      assert.deepEqual(after.agents.sibling, state.agents.sibling);
    } else {
      await assert.rejects(restartRole(options), /busy|ambiguous|differs/);
      assert.equal(sends.length, mode === 'ambiguous' ? 2 : 0);
      if (mode === 'ambiguous') {
        await assert.rejects(restartRole(options), /previous exit is unconfirmed/);
        assert.equal(sends.length, 2);
      }
    }
  });
}

for (const scenario of ['draft', 'clear-refused']) test(`restart does not send /quit when ${scenario}`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-editor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'archi', agent: 'pi', model: 'model' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'archi', agents: ['archi'] }] });
  const files = await initialize(home, project);
  const transcriptPath = path.join(home, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'original', cwd: project }) + '\n');
  saveJson(files.state, { workspace: project, agents: { archi: { agent: 'pi', tabId: 't', leafId: 'l', session: { id: 'original', transcriptPath } } } });
  const terminal = { handle: 'h', incarnationId: 'i', tabId: 't', leafId: 'l', connected: true, worktreePath: project };
  const sent = [];
  const options = { home, project, role: 'archi', focus: async () => {}, sleep: async () => {}, log: () => {}, snapshot: () => ({}),
    inspect: async () => ({ kind: 'agent', terminal, sessionPaths: [transcriptPath], sessionIds: [] }),
    cli: async args => {
      if (args[1] === 'list') return { terminals: [terminal] };
      if (args[1] === 'wait') return { wait: { satisfied: true } };
      if (args[1] === 'read') return { terminal: { source: 'screen', draft: scenario === 'draft' ? 'user text' : null } };
      if (args[1] === 'send') { sent.push(args); return { send: { accepted: false } }; }
      throw new Error(`Unexpected operation: ${args[1]}`);
    } };
  await assert.rejects(restartRole(options), scenario === 'draft' ? /draft cannot be verified empty/ : /editor clear unconfirmed/);
  assert.deepEqual(sent.map(args => args[5]), scenario === 'draft' ? [] : ['\u0015\u000b']);
  assert.equal(readJson(files.state).agents.archi.restartIntent, undefined);
});

for (const changedProcess of [false, true]) test(`restart ${changedProcess ? 'rejects a changed process' : 'retries an exit on the verified original process'}`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-intent-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'archi', agent: 'pi', model: 'model' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'archi', agents: ['archi'] }] });
  const files = await initialize(home, project);
  const transcriptPath = path.join(home, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'original', cwd: project }) + '\n');
  saveJson(files.state, { workspace: project, agents: { archi: { agent: 'pi', tabId: 't', leafId: 'l',
    session: { id: 'original', transcriptPath }, restartIntent: { sessionId: 'original', createdAt: '2026-09-23T09:00:00.000Z' } } } });
  const terminal = { handle: 'h', incarnationId: 'i', tabId: 't', leafId: 'l', connected: true, worktreePath: project };
  const sends = [];
  const options = { home, project, role: 'archi', focus: async () => {}, sleep: async () => {}, log: () => {}, snapshot: () => ({}),
    inspect: async () => ({ kind: 'agent', terminal, sessionPaths: [transcriptPath], sessionIds: [],
      providerStartedAt: changedProcess ? '2026-09-23T09:01:00.000Z' : '2026-09-23T08:00:00.000Z' }),
    cli: async args => {
      if (args[1] === 'list') return { terminals: [terminal] };
      if (args[1] === 'wait') return { wait: { satisfied: false } };
      if (args[1] === 'send') sends.push(args[5]);
      throw new Error(`Unexpected operation: ${args[1]}`);
    } };
  await assert.rejects(restartRole(options), changedProcess ? /previous exit is unconfirmed/ : /busy/);
  assert.deepEqual(sends, []);
  assert.equal(Boolean(readJson(files.state).agents.archi.restartIntent), changedProcess);
});

import { restartTeam } from '../lib/restart.mjs';
test('whole-team restart visits preset roles and reports failures without skipping later roles', async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'restart-all-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const project=normalizeProject(home);
 const names=['master','loader','archi','coder1','coder2','designer','reviewer','test','simple'];
 saveJson(path.join(home,'team.json'),names.map(name=>({name,agent:'pi',model:'model'})));
 saveJson(path.join(home,'layout.json'),{tabs:[{title:'master',agents:names.slice(0,2),direction:'vertical',ratio:0.5},...names.slice(2).map(name=>({title:name,agents:[name]}))]});
 await initialize(home,project);
 const visited=[];
 await assert.rejects(restartTeam({home,project,log:()=>{},restart:async({role})=>{visited.push(role);if(role==='loader')throw Error('busy');}}),/1\/9/);
 assert.deepEqual(visited,names);
 await restartTeam({home,project,log:()=>{},restart:async()=>{}});
});

import { resolveRestartRoles } from '../lib/restart.mjs';
test('restart accepts groups and multiple roles, deduplicates, and rejects unknown targets before restart', () => {
 const catalog=['coder1','coder2','master'].map(name=>({name,agent:'codex',model:'m'}));
 const config={tabs:[{title:'coder',agents:['coder1','coder2'],direction:'vertical',ratio:0.5},{title:'master',agents:['master']}]};
 assert.deepEqual(resolveRestartRoles(config,catalog,['coder']),['coder1','coder2']);
 assert.deepEqual(resolveRestartRoles(config,catalog,['coder1','coder2']),['coder1','coder2']);
 assert.deepEqual(resolveRestartRoles(config,catalog,['coder','coder1']),['coder1','coder2']);
 assert.throws(()=>resolveRestartRoles(config,catalog,['coder','unknown']),/Unknown restart/);
});
