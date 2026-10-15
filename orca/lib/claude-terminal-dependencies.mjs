import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function terminalDependencies(resources) {
  const candidates = [resources, process.env.ORCA_RESOURCES,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Programs/orca/resources') : null,
    process.platform === 'darwin' ? '/Applications/Orca.app/Contents/Resources' : null].filter(Boolean);
  for (const directory of candidates) {
    if (!fs.existsSync(path.join(directory, 'node_modules/ws')) || !fs.existsSync(path.join(directory, 'node_modules/tweetnacl'))) continue;
    const require = createRequire(path.join(directory, 'package.json'));
    return { WebSocket: require('ws'), nacl: require('tweetnacl') };
  }
  throw new Error('Orca terminal transport dependencies unavailable; set ORCA_RESOURCES to this Orca installation resources directory');
}
