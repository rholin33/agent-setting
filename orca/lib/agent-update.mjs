import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsProcesses } from './windows-health.mjs';

const packages = { codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent' };
const execute = promisify(execFile);

async function processInventory() {
  if (process.platform === 'win32') return windowsProcesses();
  const { stdout } = await execute('ps', ['-axo', 'comm=,args=']);
  return stdout.split('\n').map(line => ({ Name: line.trim().split(/\s+/)[0], CommandLine: line }));
}

function active(rows, agent) {
  return rows.some(row => agent === 'codex'
    ? !/app-server-daemon[\\/]releases/i.test(row.CommandLine || '') &&
      (/(?:^|[\\/])codex(?:\.exe)?$/i.test(row.Name || '') || /@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(row.CommandLine || ''))
    : /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(row.CommandLine || ''));
}

export async function runUpdateCommand(command, args) {
  // Only fixed command templates reach cmd.exe; never interpolate project paths.
  const allowed = command === 'npm' && (args.join(' ') === 'list --global --depth=0 --json' ||
    args[0] === 'view' && Object.values(packages).includes(args[1]) && args.slice(2).join(' ') === 'version --json' ||
    args.slice(0, 2).join(' ') === 'install --global' && /^(@openai\/codex|@earendil-works\/pi-coding-agent)@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(args[2]) && args.length === 3) ||
    command === 'pi' && args.join(' ') === 'update --extensions';
  if (!allowed) throw new Error('Unexpected update command');
  try {
    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `${command}.cmd ${args.join(' ')}`] : args;
    const result = await execute(executable, argv, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { status: 0, ...result };
  } catch (error) { return { status: error.code || 1, stderr: error.stderr || error.message }; }
}

export async function updateAgentsBeforeStart({ agents, processes = processInventory, run = runUpdateCommand, log = console.log, lifecycle }) {
  const result = { updated: [], deferred: [], warnings: [] };
  const names = [...new Set(agents)].filter(name => packages[name]);
  const warn = message => { result.warnings.push(message); log(`Warning: ${message}; continuing startup`); };
  const defer = name => { if (!result.deferred.includes(name)) result.deferred.push(name); log(`Update deferred: ${name} has a running process`); };
  let inventory;
  try { inventory = await processes(); }
  catch (error) { result.deferred.push(...names); warn(`Agent update skipped: ${error.message}`); return result; }
  let installed;
  const checked = async (command, args) => {
    const reply = await run(command, args);
    if (reply.error || reply.status !== 0) throw new Error(reply.error?.message || reply.stderr?.trim() || `exit ${reply.status}`);
    return reply.stdout || '';
  };
  for (const name of names) {
    let stopped = [];
    if (!lifecycle && active(inventory, name)) { defer(name); continue; }
    try {
      installed ??= JSON.parse(await checked('npm', ['list', '--global', '--depth=0', '--json']));
      const current = installed.dependencies?.[packages[name]]?.version;
      if (!current) throw new Error(`${name} is not an npm global installation; update skipped`);
      const latest = JSON.parse(await checked('npm', ['view', packages[name], 'version', '--json']));
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest)) throw new Error(`Invalid ${name} registry version`);
      const requiresUpdate = latest !== current || name === 'pi';
      if (requiresUpdate && (lifecycle || active(await processes(), name))) {
        if (!lifecycle) { defer(name); continue; }
        stopped = await lifecycle.stop(name);
      }
      if (latest !== current) {
        if (!lifecycle && active(await processes(), name)) { defer(name); continue; }
        log(`Updating ${name}: ${current} → ${latest}`);
        await checked('npm', ['install', '--global', `${packages[name]}@${latest}`]);
        log(`${name}: program update completed successfully (${latest})`);
        result.updated.push(name);
      } else log(`${name}: latest installed (${current})`);
      if (name === 'pi') {
        if (!lifecycle && active(await processes(), name)) { defer(name); continue; }
        log('Updating Pi extension packages…');
        const output = await checked('pi', ['update', '--extensions']);
        if (output.trim()) log(output.trim());
        log('Pi extension update completed successfully');
      }
    } catch (error) {
      if (/partial shutdown recovery failed/.test(error.message)) throw error;
      warn(`${name} update failed: ${error.message}`);
    }
    finally {
      if (stopped.length) {
        try { await lifecycle.resume(stopped); }
        catch (error) { throw new Error(`${name}: session recovery after update failed: ${error.message}`, { cause: error }); }
      }
    }
  }
  return result;
}
