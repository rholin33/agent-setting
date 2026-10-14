import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCodexLaunch, codexLaunchMarker, captureSession, prepareLaunch } from '../lib/launch-state.mjs';
import { normalizeProject } from '../lib/platform.mjs';

function rollout(root, project, id, text, when = new Date()) {
  const day = path.join(root, String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0'), String(when.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id, cwd: project } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('a new Codex session is found by its launch marker in either session root', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots = [path.join(dir, 'home', 'sessions'), path.join(dir, 'orca', 'sessions')];
  const intent = { id: 'intent-1', createdAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(findCodexLaunch(intent, roots), null);
  rollout(roots[0], dir, 'other-session', 'unrelated prompt');
  const file = rollout(roots[1], dir, 'new-session', `role prompt\n\n${codexLaunchMarker(intent.id)}`);
  assert.deepEqual(findCodexLaunch(intent, roots), { key: 'session_id', id: 'new-session', transcriptPath: file });
  // 启动之前修改过的文件不参与匹配。
  const old = rollout(roots[0], dir, 'stale', codexLaunchMarker(intent.id));
  fs.utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  assert.equal(findCodexLaunch(intent, roots).id, 'new-session');
  // 同一标记出现在两个会话里时拒绝猜测。
  rollout(roots[0], dir, 'duplicate', codexLaunchMarker(intent.id));
  assert.equal(findCodexLaunch(intent, roots), null);
});

test('captureSession binds a launched Codex conversation through the marker without process arguments', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capture-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = normalizeProject(dir);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(dir, 'codex');
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const saved = {};
  prepareLaunch(saved, { name: 'loader', agent: 'codex', model: 'm', thinking: 'medium' }, dir);
  const live = { kind: 'agent', sessionPaths: [], sessionIds: [], terminal: { handle: 'h', incarnationId: 'i' } };
  assert.equal(captureSession(saved, live, project, null), false);
  const file = rollout(path.join(dir, 'codex', 'sessions'), project, 'codex-new', `prompt\n\n${codexLaunchMarker(saved.launchIntent.id)}`);
  assert.equal(captureSession(saved, { ...live, kind: 'shell' }, project, null), false);
  assert.equal(captureSession(saved, live, project, null), true);
  assert.deepEqual(saved.session, { key: 'session_id', id: 'codex-new', transcriptPath: file });
  assert.equal(saved.bindingSource, 'launch-marker');
});
