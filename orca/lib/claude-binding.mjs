import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sameWorktree } from './sessions.mjs';
import { randomUUID } from 'node:crypto';

export async function probeClaudeNative(config, cli) {
  const nonce = randomUUID();
  const request = Buffer.from(JSON.stringify({ ...config.endpoint, remoteWorktree: config.remoteWorktree, nonce })).toString('base64');
  const script = Buffer.from(fs.readFileSync(new URL('../remote-master/claude_probe.py', import.meta.url))).toString('base64');
  const args = ['--terminal', config.probeTerminal, '--environment', config.environment];
  if (config.probeIncarnation) {
    const probe = (await cli(['terminal', 'show', ...args])).terminal;
    if (!probe?.connected || probe.orphaned || probe.incarnationId !== config.probeIncarnation || probe.agentIdentity) throw new Error('Claude diagnostic shell identity changed');
  }
  const screen = (await cli(['terminal', 'read', ...args, '--screen'])).terminal;
  if (screen.source !== 'screen' || !(/➜.*[✗✔]\s*$/.test(screen.tail?.at(-1) || '') ||
      (config.probeIncarnation && screen.tail?.at(-1)?.trim() === 'ORCA_CLAUDE_HEALTH>'))) throw new Error('Claude diagnostic shell is not idle');
  const command = `python3 -c 'import base64,sys;sys.argv=["probe","${request}"];exec(base64.b64decode("${script}"))'`;
  await cli(['terminal', 'send', ...args, '--text', command, '--enter']);
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const read = (await cli(['terminal', 'read', ...args, '--limit', '24000'])).terminal;
    const match = read.tail.join('').match(new RegExp(`CLAUDE_PROBE_${nonce}:([A-Za-z0-9+/=]+):END_PROBE`));
    if (match) return JSON.parse(Buffer.from(match[1], 'base64').toString());
  }
  throw new Error('Native Claude diagnostic result unconfirmed; inspect shell before retrying');
}

export function validateClaudeTerminal(config, endpoint, project, reply) {
  const t = reply.terminal;
  if (config.version !== 1 || config.role !== endpoint.role || config.environment !== endpoint.environment ||
      !sameWorktree(`local::${config.project}`, project) || !isDeepStrictEqual(config.endpoint, endpoint) ||
      !config.runtimeId || reply.runtimeId !== config.runtimeId || !t ||
      t.handle !== endpoint.terminal || t.incarnationId !== endpoint.incarnation || !t.connected || t.orphaned ||
      (t.agentIdentity !== 'claude' && (t.agentIdentity || !reply.native)) || t.worktreePath !== (config.registeredWorktree || config.remoteWorktree) ||
      (reply.native ? reply.native.session : t.providerSession?.id || t.agentSession?.id || t.session?.id || t.agentSessionId || t.sessionId) !== endpoint.session ||
      (reply.native && (reply.native.terminal !== endpoint.terminal || reply.native.incarnation !== endpoint.incarnation ||
        reply.native.ptyId !== t.ptyId || reply.native.cwd !== config.remoteWorktree || reply.native.models?.join(',') !== 'claude-opus-5-5'))) {
    throw new Error('Claude scoped terminal/native session binding changed');
  }
}

export async function verifyClaudeBinding({ config: file, endpoint, project, cli }) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reply = await cli(['terminal', 'show', '--terminal', endpoint.terminal, '--environment', endpoint.environment]);
  const status = await cli(['status', '--environment', endpoint.environment]);
  // The transport identity is obtained from the environment registry, never its display name.
  const environments = (await cli(['environment', 'list'])).environments || [];
  const matches = environments.filter(row => row.id === endpoint.environment || row.name === endpoint.environment);
  if (matches.length !== 1 || matches[0].runtimeId !== config.runtimeId || status.runtime?.runtimeId !== config.runtimeId || status.runtime?.reachable !== true) throw new Error('Claude paired runtime identity changed');
  const native = config.probeTerminal ? await probeClaudeNative(config, cli) : undefined;
  validateClaudeTerminal(config, endpoint, project, { ...reply, native, runtimeId: status.runtime.runtimeId });
}
