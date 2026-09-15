import fs from 'node:fs';
import path from 'node:path';
import { nodeCommand, quote } from './platform.mjs';
import { readJson, saveJson } from './team.mjs';

export function deploy(source, home) {
  fs.mkdirSync(home, { recursive: true });
  if (path.resolve(source) !== path.resolve(home)) {
    for (const name of ['bin', 'lib', 'roles', 'source', 'tests', 'docs', 'team.json', 'layout.json', 'package.json', 'README.md', 'FILE-INVENTORY.json']) {
      const from = path.join(source, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(home, name), { recursive: true });
    }
  }
  const entry = path.join(home, 'bin', 'orca-team.mjs');
  const windows = `function global:orca-team { & ${quote(process.execPath, 'win32')} ${quote(entry, 'win32')} --home ${quote(home, 'win32')} @args }\n`;
  const posix = `#!/bin/sh\nexec ${quote(process.execPath, 'linux')} ${quote(entry, 'linux')} --home ${quote(home, 'linux')} "$@"\n`;
  fs.writeFileSync(path.join(home, 'bin', 'orca-team.ps1'), windows);
  fs.writeFileSync(path.join(home, 'bin', 'orca-team'), posix, { mode: 0o755 });
  fs.chmodSync(path.join(home, 'bin', 'orca-team'), 0o755);
  return { powershell: path.join(home, 'bin', 'orca-team.ps1'), shellDirectory: path.join(home, 'bin') };
}
export async function installQuickCommands(home, rpc) {
  const team = readJson(path.join(home, 'team.json'));
  const commands = team.map(role => ({ id: `ccb-team-${role.name}`, label: `CCB / ${role.name}`, action: 'terminal-command', scope: { type: 'global' }, command: nodeCommand([path.join(home, 'bin', 'orca-team.mjs'), 'launch', '--home', home, '--role', role.name]), appendEnter: true }));
  const previous = await rpc('settings.getTerminalQuickCommands');
  if (previous.terminalQuickCommands.filter(command => !commands.some(item => item.id === command.id)).length + commands.length > 40) throw new Error('Orca quick command limit exceeded');
  fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
  saveJson(path.join(home, 'backups', `quick-commands-${Date.now()}.json`), previous);
  for (const command of commands) await rpc('settings.updateTerminalQuickCommands', { mutation: { type: 'upsert', command } });
  const after = await rpc('settings.getTerminalQuickCommands');
  for (const command of commands) {
    const actual = after.terminalQuickCommands.find(item => item.id === command.id);
    if (!actual || actual.command !== command.command || actual.label !== command.label) throw new Error(`Quick command readback mismatch: ${command.id}`);
  }
  return commands.length;
}

export function registerShellProfile(home, profile, platform = process.platform) {
  const start = '# >>> orca-team >>>', end = '# <<< orca-team <<<';
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
  const begin = existing.indexOf(start), finish = existing.indexOf(end);
  if ((begin === -1) !== (finish === -1) || (begin !== -1 && finish < begin)) throw new Error('Malformed orca-team profile markers');
  const entry = platform === 'win32' || /\.ps1$/i.test(profile)
    ? `. ${quote(path.join(home, 'bin', 'orca-team.ps1'), 'win32')}`
    : `export PATH=${quote(path.join(home, 'bin'), platform)}:"$PATH"`;
  const block = `${start}\n${entry}\n${end}`;
  const updated = begin === -1 ? existing + (existing.endsWith('\n') || !existing ? '' : '\n') + block + '\n' : existing.slice(0, begin) + block + existing.slice(finish + end.length);
  if (updated === existing) return;
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
  if (fs.existsSync(profile)) fs.copyFileSync(profile, path.join(home, 'backups', `shell-profile-${Date.now()}.txt`));
  fs.writeFileSync(profile, updated);
}
