import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function ompExecutable({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.ORCA_OMP_COMMAND) return env.ORCA_OMP_COMMAND;
  const candidates = platform === 'win32'
    ? [path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'omp', 'omp.exe')]
    : [path.posix.join(home, '.local', 'bin', 'omp'), path.posix.join(home, '.bun', 'bin', 'omp'), '/opt/homebrew/bin/omp', '/usr/local/bin/omp'];
  return candidates.find(exists) || 'omp';
}
