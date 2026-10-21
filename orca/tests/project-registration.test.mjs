import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInventory, confirmGitInit } from '../lib/project-registration.mjs';

const project = 'D:/Code/new-project';
const missing = () => Object.assign(new Error('missing'), { code: 'selector_not_found', selector: `path:${project}` });
const notGit = () => Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

for (const answer of [false, '', 'yes']) test(`init requires explicit true confirmation (${JSON.stringify(answer)})`, async () => {
  const calls = [];
  await assert.rejects(confirmGitInit(project, { interactive: true, confirm: async () => answer,
    runGit: args => { calls.push(args); throw notGit(); },
  }), { code: 'STARTUP_CANCELLED' });
  assert.deepEqual(calls, [['rev-parse', '--git-dir']]);
});

test('noninteractive startup never prompts or initializes Git', async () => {
  await assert.rejects(confirmGitInit(project, { interactive: false,
    confirm: async () => assert.fail('must not prompt'),
    runGit: args => { assert.equal(args[0], 'rev-parse'); throw notGit(); },
  }), { code: 'STARTUP_CANCELLED' });
});

test('approval initializes only the selected directory without commit', async () => {
  const calls = [];
  assert.equal(await confirmGitInit(project, { interactive: true,
    confirm: async selected => { assert.equal(selected, project); return true; },
    runGit: args => { calls.push(args); if (args[0] === 'rev-parse') throw notGit(); },
  }), true);
  assert.deepEqual(calls, [['rev-parse', '--git-dir'], ['init']]);
});

test('unsafe Git errors do not prompt for initialization', async () => {
  const error = Object.assign(new Error('unsafe'), { stderr: 'fatal: detected dubious ownership' });
  await assert.rejects(confirmGitInit(project, { interactive: true,
    confirm: async () => assert.fail('must not prompt'), runGit: () => { throw error; },
  }), e => e === error);
});

test('non-Git registration retries only after confirmed initialization', async () => {
  const calls = [];
  await projectInventory({ project, register: true,
    initGit: async selected => { assert.equal(selected, project); calls.push('confirmed-init'); return true; },
    cli: async args => {
      calls.push(args[0]);
      if (calls.length === 1) throw missing();
      if (calls.length === 2) throw new Error(`Not a valid git repository: ${project}`);
      return { terminals: [] };
    },
  });
  assert.deepEqual(calls, ['terminal', 'repo', 'confirmed-init', 'repo', 'terminal']);
});

test('first startup registers the exact project before retrying inventory', async () => {
  const calls = [];
  const inventory = { terminals: [] };
  const result = await projectInventory({ project, register: true, cli: async args => {
    calls.push(args);
    if (calls.length === 1) throw missing();
    return args[0] === 'repo' ? {} : inventory;
  } });
  assert.equal(result, inventory);
  assert.deepEqual(calls, [
    ['terminal', 'list', '--worktree', `path:${project}`],
    ['repo', 'add', '--path', project],
    ['terminal', 'list', '--worktree', `path:${project}`],
  ]);
});

test('existing project is reused without registration', async () => {
  let calls = 0;
  await projectInventory({ project, register: true, cli: async () => { calls++; return { terminals: [] }; } });
  assert.equal(calls, 1);
});

for (const [name, register, error] of [
  ['read-only inspection', false, missing()],
  ['another selector', true, Object.assign(missing(), { selector: 'path:D:/other' })],
  ['connection failure', true, new Error('disconnected')],
]) test(`${name} never registers`, async () => {
  let calls = 0;
  await assert.rejects(projectInventory({ project, register, cli: async () => { calls++; throw error; } }), e => e === error);
  assert.equal(calls, 1);
});

test('failed registration is not retried', async () => {
  let calls = 0;
  const failure = new Error('registration failed');
  await assert.rejects(projectInventory({ project, register: true, cli: async () => {
    if (++calls === 1) throw missing();
    throw failure;
  } }), e => e === failure);
  assert.equal(calls, 2);
});
