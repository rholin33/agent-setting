import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Local identity only. No conversation content, keys or provider configuration.
export default function (pi) {
  const write = (_event, ctx) => {
    if (process.platform !== 'darwin' || !process.env.ORCA_PANE_KEY) return;
    const manager = ctx?.sessionManager;
    const id = manager?.getSessionId?.();
    const transcriptPath = manager?.getSessionFile?.();
    if (!id || !transcriptPath) return;
    try {
    const created = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const directory = path.join(process.env.ORCA_TEAM_HOME || path.join(os.homedir(), '.orca', 'roles', 'ccb-team'), 'runtime', 'session-proofs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${process.pid}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, created, paneKey: process.env.ORCA_PANE_KEY,
      cwd: process.cwd(), session: { id, transcriptPath } }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    } catch { /* Missing proof blocks recovery, never the running Pi session. */ }
  };
  pi.on('session_start', write);
  pi.on('session_switch', write);
}
