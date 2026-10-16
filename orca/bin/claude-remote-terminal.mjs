import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { connectRemoteTerminal, localClaudeTitle } from '../lib/claude-terminal-client.mjs';
import { terminalDependencies } from '../lib/claude-terminal-dependencies.mjs';
import { normalizeProject } from '../lib/platform.mjs';
import { pairedEnvironment } from '../lib/remote-runtime.mjs';

const argv = process.argv.slice(2);
const probe = argv.includes('--probe');
const connectionId = argv.includes('--connection-id') ? argv[argv.indexOf('--connection-id') + 1] : undefined;
if (connectionId !== undefined && !/^[0-9a-f-]{36}$/.test(connectionId)) throw new Error('Invalid local connection identity');
const configFile = argv[argv.indexOf('--config') + 1];
if (!argv.includes('--config') || !configFile) throw new Error('Usage: claude-remote-terminal --config binding.json [--probe]');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (config.version !== 1 || config.endpoint?.runtime !== 'claude') throw new Error('Invalid Claude terminal binding');
if (!probe && normalizeProject(process.cwd()).toLowerCase() !== normalizeProject(config.project).toLowerCase()) throw new Error('Local project directory does not match the remote binding');
if (!config.environment) throw new Error('Invalid Claude terminal binding');
const { env, pairing } = pairedEnvironment(config.environment, { runtimeId: config.runtimeId });
const target = { runtimeId: config.runtimeId, terminal: config.endpoint.terminal, incarnation: config.endpoint.incarnation,
  worktree: config.registeredWorktree || config.remoteWorktree };
const statusFile = path.join(path.dirname(configFile), 'local-terminal-status.json');
const title = `Claude ${config.role} · Opus · remote ${env.name}`;
let connection, stopping = false, seen = 0, ping;
let nativeTitle = '', titleBuffer = '';
const publishTitle = value => {
  nativeTitle = value;
  if (!probe) process.stdout.write(`\x1b]0;${localClaudeTitle(value, title)}\x07`);
};
const record = (state, reason) => {
  if (probe) return;
  const value = { version: 1, state, ...(reason ? { reason } : {}), ...(connectionId ? { connectionId } : {}), pid: process.pid, localPane: process.env.ORCA_PANE_KEY,
    project: config.project, role: config.role, remote: config.endpoint, runtimeId: config.runtimeId, updatedAt: new Date().toISOString() };
  const temp = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, statusFile);
};
const stop = (error) => {
  if (stopping) return;
  stopping = true; clearInterval(ping);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause(); connection?.close();
  record(error ? 'disconnected' : 'detached', error?.message);
  if (!probe) process.stdout.write(`\x1b]0;${config.role} remote disconnected\x07\x1b[?2004l\x1b[?25h\r\n${error ? error.message : 'Detached; remote Claude session and history retained.'}\r\n`);
  process.exitCode = error ? 1 : 0;
};
try {
  if (!probe && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive remote terminal requires a TTY');
  connection = await connectRemoteTerminal({ pairing, target, ...terminalDependencies(),
    viewport: { cols: process.stdout.columns || 120, rows: Math.min(120, process.stdout.rows || 40) },
    onOutput(text) {
      seen += Buffer.byteLength(text);
      if (!probe) {
        // Keep the local project's role label while forwarding the native screen.
        let data = titleBuffer + text; titleBuffer = '';
        const last = data.lastIndexOf('\x1b]');
        if (last >= 0 && !/[\x07]|\x1b\\/.test(data.slice(last + 2))) { titleBuffer = data.slice(last); data = data.slice(0, last); }
        process.stdout.write(data.replace(/\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (_match, value) => { nativeTitle = value; return ''; }));
        if (nativeTitle) publishTitle(nativeTitle);
      }
    }, onTitle: publishTitle, onClose: stop });
  await connection.ready;
  if (probe) {
    console.log(JSON.stringify({ connected: true, nativeScreenBytes: seen, remoteTerminal: target.terminal, incarnation: target.incarnation, runtimeId: target.runtimeId }));
    connection.close();
  } else {
    await connection.resize({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 });
    record('connected');
    process.stdin.setRawMode(true); process.stdin.resume();
    const decoder = new StringDecoder('utf8');
    process.stdin.on('data', chunk => {
      if (chunk.length === 1 && chunk[0] === 0x1d) { stop(); return; }
      const text = decoder.write(chunk);
      if (text) connection.send(text).catch(stop);
    });
    process.stdout.on('resize', () => connection.resize({ cols: process.stdout.columns, rows: process.stdout.rows }).catch(stop));
    process.on('SIGTERM', () => stop()); process.on('SIGHUP', () => stop());
    ping = setInterval(() => connection.inspect().then(() => record('connected')).catch(stop), 10000);
  }
} catch (error) {
  stop(error);
  if (probe) console.error(error.message);
}
