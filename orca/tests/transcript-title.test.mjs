import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateTranscript } from '../lib/sessions.mjs';

test('OMP title before session preserves original identity and project checks', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-transcript-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const transcriptPath = path.join(project, 'session.jsonl');
  const session = { id: 'original', transcriptPath };
  const saved = { agent: 'omp', session };
  const write = rows => fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const title = { type: 'title', title: '中文会话标题'.repeat(600) };
  write([title, { type: 'session', id: 'original', cwd: project }]);
  assert.equal(validateTranscript(saved, project), session);
  assert.throws(() => validateTranscript(saved, project + '-other'), /mismatch/);
  assert.throws(() => validateTranscript({ ...saved, session: { ...session, id: 'other' } }, project), /mismatch/);
  write([title]);
  assert.throws(() => validateTranscript(saved, project), /header unavailable/);
  write([{ type: 'message' }, { type: 'session', id: 'original', cwd: project }]);
  assert.throws(() => validateTranscript(saved, project), /mismatch/);
});
