import fs from 'node:fs';
import path from 'node:path';
import { ompExecutable } from './omp.mjs';
import { claudeExecutable } from './claude.mjs';
import { StringDecoder } from 'node:string_decoder';
import { normalizeProject } from './platform.mjs';

export function binding(snapshot, saved, project) {
  const record = snapshot.sleepingAgentSessionsByPaneKey?.[`${saved.tabId}:${saved.leafId}`];
  if (!record) return null;
  if (record.connectionId || !sameWorktree(record.worktreeId, project)) throw new Error('Session binding does not match role/project');
  // 面板记录可能来自同标签另一窗格或过期探针；agent 不一致时以实时进程检查为准，
  // 不能据此判定角色会话冲突，否则会让整个团队无法对账。
  if (record.agent !== saved.agent) return null;
  if (saved.session?.id && record.providerSession?.id && saved.session.id !== record.providerSession.id) throw new Error('Provider conversation identity changed; original binding retained');
  // Orca 的 Codex 面板记录可能只带 session id（没有 transcript 路径）；
  // 同一会话已保存的绑定保留路径，避免因缺少路径而误判原会话不可用。
  const observed = record.providerSession || null;
  if (observed && !observed.transcriptPath && saved.session?.transcriptPath && saved.session.id === observed.id) {
    return { ...saved.session, ...observed, transcriptPath: saved.session.transcriptPath };
  }
  return observed;
}
export function sameWorktree(worktree, project) {
  const actual = worktree?.split('::').slice(1).join('::');
  if (!actual) return false;
  const norm = value => process.platform === 'win32' ? normalizeProject(value).toLowerCase() : normalizeProject(value);
  return norm(actual) === norm(project);
}
export function validateTranscript(saved, project) {
  const session = saved.session;
  if (!session?.id || !session.transcriptPath || !fs.existsSync(session.transcriptPath)) throw new Error('Original conversation unavailable; refusing fresh fallback');
  const fd = fs.openSync(session.transcriptPath, 'r');
  let first = '';
  const decoder = new StringDecoder('utf8');
  // Claude transcript 没有独立 header：开头是 last-prompt/mode 等元数据，第一条带 cwd 的记录才确定会话归属。
  const identifies = record => saved.agent === 'claude' ? typeof record.cwd === 'string' && Boolean(record.sessionId) : record.type !== 'title';
  try {
    const buffer = Buffer.alloc(4096);
    while (!first.split('\n').slice(0, -1).some(line => line && identifies(JSON.parse(line))) && first.length < 1024 * 1024) {
      const count = fs.readSync(fd, buffer); if (!count) break;
      first += decoder.write(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  // OMP may prepend a title metadata record before the session header.
  const records = first.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
  const row = records.find(identifies);
  if (!row) throw new Error('Original conversation header unavailable');
  const meta = ['pi', 'omp'].includes(saved.agent) && row.type === 'session' ? row : saved.agent === 'codex' && row.type === 'session_meta' ? row.payload
    : saved.agent === 'claude' ? { id: row.sessionId, cwd: row.cwd } : null;
  if (!meta || meta.id !== session.id || !sameWorktree(`local::${meta.cwd}`, project)) throw new Error('Original conversation identity/project mismatch');
  return session;
}
export function launchArguments(role, prompt, session, project, home, { codexNoDaemon = false } = {}) {
  // 模型来自账本；Codex 账本在每次 start 时同步为本机 Codex 配置，显式传入
  // 可避免 resume 恢复会话内记录的旧模型和推理强度。
  const args = ['--model', role.model];
  const env = {};
  if (session) validateTranscript({ ...role, session }, project);
  if (['pi', 'omp'].includes(role.agent)) {
    if (session) args.push('--session', session.transcriptPath);
    args.push('--append-system-prompt', prompt);
    if (home && role.agent === 'pi' && process.platform === 'darwin') {
      args.push('--extension', path.join(home, 'lib', 'pi-session-proof.ts'));
      env.ORCA_TEAM_HOME = home;
    }
    if (role.role) {
      if (!home || !/^agentroles\.[a-zA-Z0-9_-]+$/.test(role.role)) throw new Error(`Invalid Pi role: ${role.role}`);
      const skills = path.join(home, 'source', role.role.slice('agentroles.'.length), 'skills');
      if (fs.existsSync(skills)) {
 if (role.agent === 'omp') {
 const overlay=path.join(home,'generated',`${role.role}.omp.json`);
 fs.mkdirSync(path.dirname(overlay),{recursive:true});
 fs.writeFileSync(overlay,JSON.stringify({skills:{customDirectories:[skills]}}));
 args.push('--config',overlay);
 } else args.push('--skill',skills);
 }
    }
    if (role.agent === 'omp') args.push('--config', path.join(home, 'omp-context.json'));
    if (role.thinking) args.push('--thinking', role.thinking);
  } else if (role.agent === 'codex') {
    // Each pane needs its own server: a shared daemon sends every pane's
    // hooks using the first pane's Orca identity (Codex >= 0.156).
    if (codexNoDaemon) args.push('--no-daemon');
    if (session) {
      args.unshift('resume', session.id);
      let directory = path.dirname(session.transcriptPath);
      while (path.basename(directory) !== 'sessions' && path.dirname(directory) !== directory) directory = path.dirname(directory);
      if (path.basename(directory) !== 'sessions') throw new Error('Original Codex home cannot be determined');
      env.CODEX_HOME = path.dirname(directory);
    }
    if (role.thinking) args.push('-c', `model_reasoning_effort="${role.thinking}"`);
    if (!session) args.push(fs.readFileSync(prompt, 'utf8'));
  } else if (role.agent === 'claude') {
    // 角色提示每次启动都追加（Claude 不在会话里持久化 system prompt），resume 时同样需要。
    if (session) args.push('--resume', session.id);
    args.push('--append-system-prompt-file', prompt);
    if (role.thinking) args.push('--effort', role.thinking);
  } else throw new Error('Unknown provider');
  const executable = role.agent === 'omp' ? ompExecutable() : role.agent === 'claude' ? claudeExecutable() : role.agent;
  return { executable, args, env };
}
