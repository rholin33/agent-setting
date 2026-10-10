import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory } from './platform.mjs';

export async function orca(args) {
  let result;
  try {
    result = { ...await promisify(execFile)(process.env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca'), [...args, '--json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }), status: 0 };
  } catch (error) {
    if (!error.stdout) throw error;
    result = { stdout: error.stdout, status: error.code };
  }
  let reply;
  try { reply = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Orca returned invalid JSON; request will not be retried.'); }
  const unsatisfiedWait = args[0] === 'terminal' && args[1] === 'wait' && reply.ok === true &&
    typeof reply.result?.wait?.satisfied === 'boolean';
  if ((!unsatisfiedWait && result.status !== 0) || reply.ok === false) {
    const error = new Error(reply.error?.message || reply.error?.code || `Orca command failed: ${JSON.stringify(reply.error || reply)}`);
    error.code = reply.error?.code;
    error.selector = reply.error?.data?.selector;
    throw error;
  }
  return reply.result ?? reply;
}
export function snapshot() {
  const profile = process.env.ORCA_TEAM_PROFILE || 'local-default';
  if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid Orca profile name');
  const file = path.join(dataDirectory(), 'profiles', profile, 'orca-data.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).workspaceSession || {};
}
export async function rpc(method, params = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(dataDirectory(), 'orca-runtime.json'), 'utf8'));
  const transport = metadata.transports.find(t => ['named-pipe', 'unix'].includes(t.kind));
  if (!transport) throw new Error('No local Orca socket transport available');
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(transport.endpoint);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => socket.destroy(new Error('Orca RPC timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id, authToken: metadata.authToken, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { socket.destroy(); reject(new Error('Invalid Orca RPC JSON')); return; }
        if (frame._keepalive) continue;
        socket.end();
        if (frame.id !== id || !frame.ok) reject(new Error(frame.error?.message || 'Orca RPC failed'));
        else resolve(frame.result);
        return;
      }
    });
    socket.on('end', () => reject(new Error('Orca RPC ended before response')));
  });
}
