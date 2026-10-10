import assert from 'node:assert/strict';
import test from 'node:test';
import { isRuntimeError } from '../lib/orca-boot.mjs';

test('recognizes the CLI runtime_unavailable response as requiring startup', () => {
  const error = new Error('Could not connect to the running Orca app. Restart Orca and try again.');
  error.code = 'runtime_unavailable';
  assert.equal(isRuntimeError(error), true);
});

test('recognizes a connection failure even when the CLI omits its error code', () => {
  assert.equal(isRuntimeError(new Error('Could not connect to the running Orca app. Restart Orca and try again.')), true);
});

test('workspace selector errors do not trigger an app launch', () => {
  const error = new Error('No worktree matches path:D:/Code/example');
  error.code = 'worktree_not_found';
  assert.equal(isRuntimeError(error), false);
});
