import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFiles, withLock, saveJson, readJson } from './team.mjs';
import { quote } from './platform.mjs';
import { registerAuxiliary } from './auxiliary-cleanup.mjs';

// Persist before create: an ambiguous transport must never open a second repair agent.
export async function openRepair({ home, project, args, error, cli, skill = path.join(os.homedir(), '.codex', 'skills', 'orca-team-repair', 'SKILL.md') }) {
  if (!fs.existsSync(skill)) throw new Error(`Repair skill missing: ${skill}`);
  const directory = path.dirname(projectFiles(home, project).state);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'startup-repair.json');
  return withLock(path.join(directory, 'startup-repair.lock'), async () => {
    if (fs.existsSync(file)) {
      const saved = readJson(file);
      if (['starting', 'uncertain', 'running'].includes(saved.status)) {
        if (saved.terminal) {
          const live = (await cli(['terminal', 'show', '--terminal', saved.terminal])).terminal;
          if (live.connected && !live.orphaned) return { ...saved, file };
          // A closed terminal is not proof its repair action has finished.
        }
        return { ...saved, status: 'uncertain', file };
      }
    }
    const record = { version: 1, status: 'starting', home, project, args, error: error || null, createdAt: new Date().toISOString() };
    saveJson(file, record); fs.chmodSync(file, 0o600);
    const prompt = `Load the orca-team-repair skill at ${JSON.stringify(skill)}. Repair request: ${JSON.stringify(file)}. This is startup recovery only. Read the durable request and inspect current state before any mutation. Preserve exact native histories. Retry the original command with --no-repair after fixing the verified cause. Record completed or blocked in this request file with evidence; do not perform business tasks.`;
    const command = (process.platform === 'win32' ? '' : 'command ') + ['codex', prompt].map(value => quote(value)).join(' ');
    try {
      const result = await cli(['terminal', 'create', '--worktree', `path:${project}`, '--title', 'orca-team-repair', '--command', command]);
      if (!result.terminal?.handle) throw new Error('Repair terminal creation unconfirmed');
      Object.assign(record, { status: 'running', terminal: result.terminal.handle, incarnation: result.terminal.incarnationId });
      saveJson(file, record); fs.chmodSync(file, 0o600);
      try { registerAuxiliary({ home, project, kind: 'startup-repair', terminal: result.terminal, repairCreatedAt: record.createdAt }); }
      catch { console.warn(`Repair ${record.terminal}: automatic cleanup registration failed; retain for explicit reconciliation.`); }
      return { ...record, file };
    } catch (error) {
      record.status = 'uncertain'; saveJson(file, record); fs.chmodSync(file, 0o600);
      throw error;
    }
  });
}
