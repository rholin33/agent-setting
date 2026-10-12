import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeExecutable(env = process.env) {
  return env.ORCA_CLAUDE_COMMAND || 'claude';
}

export function claudeHome(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

// Claude Code 按 cwd 编码目录存放 projects/<dir>/<session-id>.jsonl；编码规则随版本变化，
// 因此按会话 UUID 精确查找，并要求唯一匹配，避免把同名文件误判为原会话。
export function claudeTranscriptPath(id, { root = claudeHome() } = {}) {
  if (!UUID.test(id || '')) throw new Error('Invalid Claude session id');
  const projects = path.join(root, 'projects');
  if (!fs.existsSync(projects)) return null;
  const matches = fs.readdirSync(projects, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => path.join(projects, entry.name, `${id}.jsonl`))
    .filter(file => fs.existsSync(file));
  if (matches.length > 1) throw new Error('Claude session transcript is ambiguous');
  return matches[0] || null;
}

// 只接受 --session-id/--resume/-r 后紧跟的 UUID，进程参数里其它位置的 UUID 不构成会话证据。
export function claudeSessionIds(command) {
  const ids = [...command.matchAll(/(?:^|\s)(?:--session-id|--resume|-r)(?:=|\s+)"?([0-9a-f-]{36})"?(?=\s|$)/gi)].map(match => match[1]);
  return [...new Set(ids.filter(id => UUID.test(id)))];
}
