import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { agentCommand } from '../lib/platform.mjs';

test('Windows native launch preserves quoted multiline role prompts through a PowerShell wrapper', { skip: process.platform !== 'win32' }, () => {
  const prompt = 'Initialize role "ready"\n路径 with \'quote\' and $literal; no expansion';
  const { executable, args } = agentCommand(process.execPath, ['-p', 'JSON.stringify(process.argv.slice(1))', prompt, '-c', 'effort="xhigh"']);
  const out = execFileSync(executable, args, { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(out), [prompt, '-c', 'effort="xhigh"']);
});

test('POSIX agent launch keeps direct executable and arguments', () => {
  assert.deepEqual(agentCommand('codex', ['prompt'], 'linux'), { executable: 'codex', args: ['prompt'] });
});
