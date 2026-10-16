import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openRepair } from '../lib/startup-repair.mjs';
for (const ambiguous of [false, true]) test(`repair creation is at most once, ambiguous=${ambiguous}`, async () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-repair-'));
 const skill = path.join(home, 'SKILL.md'); fs.writeFileSync(skill, 'fixture');
 let created = 0;
 const cli = async args => {
  if (args[1] === 'create') { created++; if (ambiguous) throw new Error('lost reply'); return { terminal: { handle: 'repair' } }; }
  if (args[1] === 'show') return { terminal: { connected: true } };
  throw new Error('unexpected mutation');
 };
 const options = { home, project: home, skill, args: ['start'], cli };
 if (ambiguous) await assert.rejects(openRepair(options), /lost reply/); else assert.equal((await openRepair(options)).terminal, 'repair');
 const next = await openRepair(options);
 assert.equal(next.status, ambiguous ? 'uncertain' : 'running');
 assert.equal(created, 1);
});

test('Windows repair command invokes Codex with the exact prompt as one argument', { skip: process.platform !== 'win32' }, async t => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "orca repair '$-"));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 const skill = path.join(home, 'SKILL.md'); fs.writeFileSync(skill, 'fixture');
 let command;
 await openRepair({ home, project: home, skill, args: ['start'], cli: async args => {
  assert.equal(args[1], 'create'); command = args[args.indexOf('--command') + 1];
  return { terminal: { handle: 'repair', incarnationId: 'inc' } };
 } });
 const capture = path.join(home, 'capture.mjs');
 fs.writeFileSync(capture, "console.log(Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'));\n");
 const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
 fs.writeFileSync(path.join(home, 'codex.ps1'), `& ${psQuote(process.execPath)} ${psQuote(capture)} @args\n`);
 const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, Path: home + path.delimiter + process.env.Path },
 });
 const prompts = JSON.parse(Buffer.from(output.trim(), 'base64').toString('utf8'));
 assert.equal(prompts.length, 1);
 const [prompt] = prompts;
 assert.ok(prompt.startsWith(`Load the orca-team-repair skill at ${JSON.stringify(skill)}.`));
 assert.ok(prompt.endsWith('do not perform business tasks.'));
});
