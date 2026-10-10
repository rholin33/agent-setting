import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateTranscript } from './sessions.mjs';

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
