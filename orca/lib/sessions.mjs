import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { normalizeProject } from './platform.mjs';

export function binding(snapshot, saved, project) {
  const record = snapshot.sleepingAgentSessionsByPaneKey?.[`${saved.tabId}:${saved.leafId}`];
  if (!record) return null;
  if (record.connectionId || record.agent !== saved.agent || !sameWorktree(record.worktreeId, project)) throw new Error('Session binding does not match role/project');
  if (saved.session?.id && record.providerSession?.id && saved.session.id !== record.providerSession.id) throw new Error('Provider conversation identity changed; original binding retained');
  return record.providerSession || null;
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
  try {
    const buffer = Buffer.alloc(4096);
    while (!first.includes('\n') && first.length < 1024 * 1024) {
      const count = fs.readSync(fd, buffer); if (!count) break;
      first += decoder.write(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  const row = JSON.parse(first.split('\n')[0]);
  const meta = saved.agent === 'pi' && row.type === 'session' ? row : saved.agent === 'codex' && row.type === 'session_meta' ? row.payload : null;
  if (!meta || meta.id !== session.id || !sameWorktree(`local::${meta.cwd}`, project)) throw new Error('Original conversation identity/project mismatch');
  return session;
}
export function launchArguments(role, prompt, session, project, home) {
  const args = ['--model', role.model];
  const env = {};
  if (session) validateTranscript({ ...role, session }, project);
  if (role.agent === 'pi') {
    if (session) args.push('--session', session.transcriptPath);
    args.push('--append-system-prompt', prompt);
    if (role.role) {
      if (!home || !/^agentroles\.[a-zA-Z0-9_-]+$/.test(role.role)) throw new Error(`Invalid Pi role: ${role.role}`);
      const skills = path.join(home, 'source', role.role.slice('agentroles.'.length), 'skills');
      if (fs.existsSync(skills)) args.push('--skill', skills);
    }
    if (role.thinking) args.push('--thinking', role.thinking);
  } else if (role.agent === 'codex') {
    if (session) {
      args.unshift('resume', session.id);
      let directory = path.dirname(session.transcriptPath);
      while (path.basename(directory) !== 'sessions' && path.dirname(directory) !== directory) directory = path.dirname(directory);
      if (path.basename(directory) !== 'sessions') throw new Error('Original Codex home cannot be determined');
      env.CODEX_HOME = path.dirname(directory);
    }
    if (role.thinking) args.push('-c', `model_reasoning_effort="${role.thinking}"`);
    if (!session) args.push(fs.readFileSync(prompt, 'utf8'));
  } else throw new Error('Unknown provider');
  return { executable: role.agent, args, env };
}
