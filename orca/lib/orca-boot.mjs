import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { dataDirectory } from './platform.mjs';
import { orca } from './orca.mjs';

const runtimeFile = () => path.join(dataDirectory(), 'orca-runtime.json');

// A workspace selector problem still proves the app is up; only runtime/CLI
// failures mean Orca itself is not running.
export function isRuntimeError(error) {
  const message = String(error?.message || '');
  return error?.code === 'ENOENT' ||
    /not running|runtime|metadata|invalid JSON|ECONNREFUSED|EPERM|timed? ?out/i.test(message);
}

function probe(cli) {
  try { cli(['terminal', 'list']); return true; }
  catch (error) { return !isRuntimeError(error); }
}

function launchOrca() {
  if (process.platform === 'win32') {
    const exe = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'Orca.exe');
    if (fs.existsSync(exe)) { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return exe; }
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Orca'], { detached: true, stdio: 'ignore' }).unref();
    return 'open -a Orca';
  }
  const cli = process.env.ORCA_CLI_COMMAND || 'orca-ide';
  spawn(cli, ['open'], { detached: true, stdio: 'ignore' }).unref();
  return cli;
}

// Returns false when Orca already answered, true when it had to be started.
export async function ensureOrca({ cli = orca, log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 120000 } = {}) {
  if (probe(cli)) return false;
  log('Orca runtime is not available; starting Orca…');
  if (process.platform !== 'win32' || !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'orca', 'Orca.exe'))) {
    const command = process.env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca');
    try {
      const open = spawnSync(command, ['open', '--json'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (!open.error && open.status === 0) log('Orca open command accepted');
    } catch { /* fall through to a direct executable launch */ }
  }
  const launched = launchOrca();
  log(`Launched ${launched}; waiting for the Orca runtime…`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(runtimeFile()) && probe(cli)) { log('Orca is ready'); return true; }
    await sleep(1000);
  }
  throw new Error(`Orca did not become ready within ${Math.round(timeoutMs / 1000)}s; start it manually and rerun orca-team`);
}
