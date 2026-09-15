import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartRole } from '../lib/restart.mjs';
import { initialize, readJson, saveJson } from '../lib/team.mjs';
import { normalizeProject } from '../lib/platform.mjs';

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
    let phase = 'agent'; const sends = [];
    const options = { home, project, role: 'archi', snapshot: () => ({}), log: () => {}, sleep: async () => {},
      inspect: async () => ({ kind: phase, terminal, sessionPaths: provider === 'pi' ? [mode === 'changed' ? 'other' : transcriptPath] : [], sessionIds: provider === 'codex' ? [mode === 'changed' ? 'other' : 'original'] : [] }),
      cli: async args => {
        const verb = args[1];
        if (verb === 'list') return { terminals: [terminal] };
        if (verb === 'wait') return { wait: { satisfied: mode !== 'busy' } };
        if (verb === 'read') return { terminal: { tail: ['PS C:\\project>'] } };
        if (verb === 'send') {
          sends.push(args);
          assert.equal(args[3], 'h');
          if (sends.length === 1) {
            assert.equal(args[5], '/quit');
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
      assert.equal(sends.length, 2);
      assert.equal(after.agents.archi.session.id, 'original');
      assert.equal(after.agents.archi.restartIntent, undefined);
      assert.equal(after.agents.archi.pending, undefined);
      assert.deepEqual(after.agents.sibling, state.agents.sibling);
    } else {
      await assert.rejects(restartRole(options), /busy|ambiguous|differs/);
      assert.equal(sends.length, mode === 'ambiguous' ? 1 : 0);
      if (mode === 'ambiguous') {
        await assert.rejects(restartRole(options), /previous exit is unconfirmed/);
        assert.equal(sends.length, 1);
      }
    }
  });
}
