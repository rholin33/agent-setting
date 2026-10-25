import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateTranscript, readTranscriptHeader, CLAUDE_PERMISSION_MODE } from './sessions.mjs';
import { claudeTranscriptPath } from './claude.mjs';
import { dataDirectory } from './platform.mjs';

// 新 Codex 会话的进程参数和 Orca 实时接口都不带会话 ID：启动时首条消息附带本次 launchIntent 标记，
// 再在 Codex 会话目录中按标记找到唯一的会话记录。macOS 与 Windows 通用。
const CODEX_MARKER_SCAN_BYTES = 512 * 1024;
const CODEX_CLOCK_SKEW_MS = 5000;
export const codexLaunchMarker = id => `[orca-launch ${id}]`;
export function codexSessionRoots(env = process.env, home = os.homedir()) {
  return [env.CODEX_HOME || path.join(home, '.codex'), path.join(dataDirectory(), 'codex-runtime-home', 'home')].map(root => path.join(root, 'sessions'));
}
export function findCodexLaunch(intent, roots = codexSessionRoots(), now = Date.now()) {
  const created = Date.parse(intent.createdAt), marker = codexLaunchMarker(intent.id);
  const pad = value => String(value).padStart(2, '0');
  // 会话目录按日期分组；本地时区与 UTC 都可能被使用，启动日与今天都要覆盖。
  const days = new Set([created, now].flatMap(time => {
    const date = new Date(time);
    return [[date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())], [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())]].map(parts => path.join(...parts.map(String)));
  }));
  const matches = [];
  for (const root of new Set(roots)) for (const day of days) {
    const directory = path.join(root, day);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!/^rollout-.*\.jsonl$/.test(name) || fs.statSync(file).mtimeMs < created - CODEX_CLOCK_SKEW_MS) continue;
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(CODEX_MARKER_SCAN_BYTES);
        if (buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').includes(marker)) matches.push(file);
      } finally { fs.closeSync(fd); }
    }
  }
  if (matches.length !== 1) return null;
  const header = JSON.parse(fs.readFileSync(matches[0], 'utf8').split('\n')[0]);
  return header.type === 'session_meta' && header.payload?.id ? { key: 'session_id', id: header.payload.id, transcriptPath: matches[0] } : null;
}

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
      const header = readTranscriptHeader(candidates[0], saved.agent);
      if (header === undefined) return false;
      if (!header?.id) throw new Error('Original conversation identity/project mismatch');
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
  let markerProof = false;
  if (!session && saved.agent === 'codex' && saved.launchIntent?.id) {
    session = findCodexLaunch(saved.launchIntent);
    // Codex 首轮写入会话记录前没有文件，启动期间重试。
    if (!session) return false;
    markerProof = true;
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
  // 新 Codex 会话的 ID 不出现在进程参数或 Orca 接口里：按标记认领后，只要仍是同一 PTY 代际中的同一个
  // Codex 进程（进程号与启动时间不变），就仍是该会话。Codex 以 resume <id> 重启后改由参数证明。
  const markerContinuity = !markerProof && saved.agent === 'codex' && saved.bindingSource === 'launch-marker' &&
    saved.session?.id === session.id && Boolean(live.providerProcess) && live.providerProcess === saved.providerProcess &&
    live.terminal?.incarnationId === saved.incarnationId;
  if (!observed && !paths.length && !live.sessionIds?.length && !markerProof && !markerContinuity) return false;
  saved.session = session;
  saved.bindingSource = paths.length || live.sessionIds?.length ? 'process-arguments' : markerProof || markerContinuity ? 'launch-marker' : 'orca-pane';
  if (markerProof) saved.providerProcess = live.providerProcess;
  saved.lastVerifiedAt = new Date().toISOString();
  if (live.terminal) Object.assign(saved, { handle: live.terminal.handle, incarnationId: live.terminal.incarnationId });
  return true;
}

// 配置指纹：CLI、模型、思考强度、角色提示内容和 Claude 权限模式。指纹不变的运行中角色在 start 时直接复用。
export function appliedModelOf(catalogRole, home) {
  const applied = { agent: catalogRole.agent, model: catalogRole.model, thinking: catalogRole.thinking ?? null };
  if (catalogRole.agent === 'claude') applied.permission = CLAUDE_PERMISSION_MODE;
  const prompt = home && path.join(home, 'roles', `${catalogRole.name}.md`);
  if (prompt && fs.existsSync(prompt)) applied.prompt = createHash('sha256').update(fs.readFileSync(prompt)).digest('hex').slice(0, 16);
  return applied;
}
// 旧状态没有提示指纹时只比较模型字段，升级后不会因此重启全部角色。
// 权限模式不做此豁免：旧 Claude 状态没有记录权限，无法证明进程以当前权限启动，必须重启一次。
export function sameAppliedConfig(saved, catalogRole, home) {
  const applied = saved.appliedModel, desired = appliedModelOf(catalogRole, home);
  if (!applied) return false;
  return applied.agent === desired.agent && applied.model === desired.model && (applied.thinking ?? null) === desired.thinking &&
    (applied.prompt === undefined || applied.prompt === desired.prompt) && (applied.permission ?? null) === (desired.permission ?? null);
}
