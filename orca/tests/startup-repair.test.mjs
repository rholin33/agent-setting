import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
