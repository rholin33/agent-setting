import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsNoDaemon } from '../lib/codex-capabilities.mjs';
import { launchArguments } from '../lib/sessions.mjs';
test('Codex runtime isolation is enabled only when the CLI supports it', () => {
  assert.equal(supportsNoDaemon(() => ({status:0,stdout:'Options:\n  --no-daemon  Run without shared server'})),true);
  for (const reply of [{status:0,stdout:'old CLI'},{status:1,stdout:'--no-daemon'},{status:null,error:new Error('missing')}]) {
    assert.equal(supportsNoDaemon(() => reply),false);
  }
});
