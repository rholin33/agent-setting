import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateTranscript } from './sessions.mjs';
import { claudeTranscriptPath } from './claude.mjs';

export function prepareLaunch(saved, role, directory) {
  if (saved.session || saved.launchIntent) return;
  Object.assign(saved, { agent: role.agent, model: role.model, thinking: role.thinking });
  const id = randomUUID();
  saved.launchIntent = { id, createdAt: new Date().toISOString(),
    ...(['pi', 'omp'].includes(role.agent) ? { transcriptPath: path.join(directory, 'sessions', `${role.name}-${id}.jsonl`) } : {}) };
}

export function captureSession(saved, live, project, observed) {
  let session = observed || saved.session;
  const paths = live.sessionPaths || [];
  const explicit = saved.launchIntent?.transcriptPath;
  if (!session && ['pi', 'omp'].includes(saved.agent)) {
    const candidates = explicit ? [explicit] : [...new Set(paths)];
    if (candidates.length === 1 && fs.existsSync(candidates[0])) {
      const text = fs.readFileSync(candidates[0], 'utf8');
      // Pi precreates the file before writing its session header. Retry during startup.
      if (!text.includes('\n')) return false;
      const header = JSON.parse(text.split('\n')[0]);
      session = { key: 'session_id', id: header.id, transcriptPath: candidates[0] };
    }
  }
  if (!session && saved.agent === 'claude') {
    // 新会话使用启动前写入 launchIntent 的 --session-id；进程参数必须证明是同一个 UUID。
    const id = saved.launchIntent?.id;
    if (!id || !live.sessionIds?.includes(id)) return false;
    const transcriptPath = claudeTranscriptPath(id);
    // Claude 在首条消息写入前只有元数据行，带 cwd 的记录出现后才能校验归属；启动期间重试。
    if (!transcriptPath || !fs.readFileSync(transcriptPath, 'utf8').split('\n').some(line => line.includes('"cwd"'))) return false;
    session = { key: 'session_id', id, transcriptPath };
  }
  if (session && explicit && session.transcriptPath !== explicit) throw new Error('Launch intent transcript differs from Orca binding');
  if (!session) return false;
  if (saved.session && saved.session.id !== session.id) throw new Error('Conversation changed; original binding retained');
  validateTranscript({ ...saved, session }, project);
  // A proven process argument is stronger than a stale sleeping-pane record.
  const normalize = p => process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
  if (paths.length && !paths.some(p => normalize(p) === normalize(session.transcriptPath))) throw new Error('Live conversation differs from saved binding');
  if (live.sessionIds?.length && !live.sessionIds.includes(session.id)) throw new Error('Live conversation differs from saved binding');
  if (live.kind !== 'agent') return false;
  if (!observed && !paths.length && !live.sessionIds?.length) return false;
  saved.session = session;
  saved.bindingSource = paths.length || live.sessionIds?.length ? 'process-arguments' : 'orca-pane';
  saved.lastVerifiedAt = new Date().toISOString();
  if (live.terminal) Object.assign(saved, { handle: live.terminal.handle, incarnationId: live.terminal.incarnationId });
  return true;
}

// 配置指纹：CLI、模型、思考强度和角色提示内容。指纹不变的运行中角色在 start 时直接复用。
export function appliedModelOf(catalogRole, home) {
  const applied = { agent: catalogRole.agent, model: catalogRole.model, thinking: catalogRole.thinking ?? null };
  const prompt = home && path.join(home, 'roles', `${catalogRole.name}.md`);
  if (prompt && fs.existsSync(prompt)) applied.prompt = createHash('sha256').update(fs.readFileSync(prompt)).digest('hex').slice(0, 16);
  return applied;
}
// 旧状态没有提示指纹时只比较模型字段，升级后不会因此重启全部角色。
export function sameAppliedConfig(saved, catalogRole, home) {
  const applied = saved.appliedModel, desired = appliedModelOf(catalogRole, home);
  if (!applied) return false;
  return applied.agent === desired.agent && applied.model === desired.model && (applied.thinking ?? null) === desired.thinking &&
    (applied.prompt === undefined || applied.prompt === desired.prompt);
}
