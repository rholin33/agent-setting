import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.ORCA_TEAM_DATA_DIR) return env.ORCA_TEAM_DATA_DIR;
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'orca');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'orca');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'orca');
}
export function normalizeProject(value, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const resolved = api.resolve(value).replaceAll('\\', '/');
  return resolved.length > api.parse(resolved).root.length ? resolved.replace(/\/$/, '') : resolved;
}
export function projectKey(project, platform = process.platform) {
  const normalized = normalizeProject(project, platform);
  return createHash('sha256').update(platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 16);
}
export function quote(value, platform = process.platform) {
  return platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
}
export function nodeCommand(args, platform = process.platform, executable = process.execPath) {
  const command = [executable, ...args].map(value => quote(value, platform)).join(' ');
  // Orca Windows terminals use PowerShell; encoded scripts avoid nested command quoting.
  return platform === 'win32' ? 'powershell.exe -NoLogo -NoProfile -EncodedCommand ' + Buffer.from('& ' + command, 'utf16le').toString('base64') : command;
}
