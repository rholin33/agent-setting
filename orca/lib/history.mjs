import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { dataDirectory } from './platform.mjs';
import { sameWorktree } from './sessions.mjs';
import { projectFiles, readJson, saveJson, withLock } from './team.mjs';

export function sessionRoots(home, state, env = process.env, userHome = os.homedir()) {
  const roots = [path.join(env.PI_CODING_AGENT_DIR || path.join(userHome, '.pi', 'agent'), 'sessions'),
    path.join(env.CODEX_HOME || path.join(userHome, '.codex'), 'sessions'),
    path.join(dataDirectory(), 'codex-runtime-home', 'home', 'sessions'),
    projectFiles(home, state.workspace).directory];
  for (const saved of Object.values(state.agents)) if (saved.session?.transcriptPath) roots.push(path.dirname(saved.session.transcriptPath));
  return [...new Set(roots)];
}

export function dispatchMarker(text) {
  if (!text.trimStart().startsWith('You are working inside Orca, a multi-agent IDE.')) return null;
  const preamble = text.split(/^=== TASK ===\s*$/m)[0];
  const taskId = preamble.match(/^Your task ID is: (\S+)/m)?.[1];
  const ids = [...new Set([...preamble.matchAll(/--dispatch-id ([\w-]+)/g)].map(match => match[1]))];
  const handles = [...new Set([...preamble.matchAll(/--from (term_[\w-]+)/g)].map(match => match[1]))];
  if (!taskId || ids.length !== 1 || handles.length !== 1) return null;
  return { taskId, dispatchId: ids[0], workerHandle: handles[0] };
}

async function scanTranscript(file, project) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let session, first = true;
  const dispatches = new Map();
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line.replace(/^\uFEFF/, '')); }
      catch { throw new Error('invalid_jsonl'); }
      if (first) {
        first = false;
        const meta = row.type === 'session' ? row : row.type === 'session_meta' ? row.payload : null;
        if (!meta?.id || !sameWorktree(`local::${meta.cwd}`, project)) return null;
        session = { id: meta.id, transcriptPath: file, provider: row.type === 'session' ? 'pi' : 'codex' };
        continue;
      }
      const message = row.type === 'message' ? row.message : row.type === 'response_item' ? row.payload : null;
      if (message?.role !== 'user') continue;
      const content = typeof message.content === 'string' ? message.content :
        (message.content || []).filter(item => ['text', 'input_text'].includes(item.type)).map(item => item.text).join('\n');
      const marker = dispatchMarker(content);
      if (marker) dispatches.set(`${marker.taskId}:${marker.dispatchId}`, marker);
    }
    return session ? { ...session, dispatches: [...dispatches.values()] } : null;
  } finally { lines.close(); input.destroy(); }
}

async function scanRoots(roots, project, warnings) {
  const seen = new Set(), sessions = [];
  async function visit(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`Cannot inspect ${file}: ${error.code}`);
      return;
    }
    if (stat.isSymbolicLink()) return;
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    if (stat.isDirectory()) {
      let children;
      try { children = fs.readdirSync(file); } catch (error) { warnings.push(`Cannot list ${file}: ${error.code}`); return; }
      for (const child of children) await visit(path.join(file, child));
    } else if (stat.isFile() && file.endsWith('.jsonl')) {
      try { const session = await scanTranscript(file, project); if (session) sessions.push(session); }
      catch { warnings.push(`Transcript incomplete or unreadable: ${file}`); }
    }
  }
  for (const root of roots) await visit(root);
  return sessions;
}

async function pages(cli, args, key) {
  const rows = [], seen = new Set();
  let cursor;
  do {
    const reply = await cli([...args, ...(cursor != null ? ['--cursor', String(cursor)] : [])]);
    if (!Array.isArray(reply[key])) throw new Error(`Unsupported Orca ${key} response`);
    rows.push(...reply[key]);
    cursor = reply.page?.nextCursor ?? reply.nextCursor;
    if (cursor != null && seen.has(String(cursor))) throw new Error('Repeated Orca history cursor');
    if (reply.page?.hasMore && cursor == null) throw new Error('Missing Orca history cursor');
    seen.add(String(cursor));
  } while (cursor != null);
  return rows;
}

export async function taskHistory({ home, project, role, cli, cached = false, roots }) {
  const files = projectFiles(home, project);
  return withLock(files.lock, async () => {
    const state = readJson(files.state);
    if (state.workspace !== project) throw new Error('Project state path mismatch');
    if (role && !state.agents[role]) throw new Error(`Unknown saved role: ${role}`);
    const file = path.join(files.directory, 'history.json');
    const previous = fs.existsSync(file) ? readJson(file) : null;
    if (previous && (previous.project !== project || previous.version !== 1)) throw new Error('History cache identity/version mismatch');
    let index = previous;
    if (!cached) {
      const warnings = [], workers = [], tasks = new Map();
      let metadataComplete = true;
      try {
        for (const run of await pages(cli, ['orchestration', 'run-list'], 'runs')) {
          const rows = await pages(cli, ['orchestration', 'worker-list', '--run', run.id], 'workers');
          const local = rows.filter(row => sameWorktree(row.resource?.worktreeId || row.projection?.workspace?.id, project) &&
            (!row.projection?.host || row.projection.host.kind === 'local'));
          workers.push(...local);
          if (local.length) {
            const reply = await cli(['orchestration', 'task-list', '--run', run.id]);
            if (!Array.isArray(reply.tasks)) throw new Error('Unsupported Orca tasks response');
            for (const task of reply.tasks) tasks.set(task.id, task);
          }
        }
      } catch (error) { metadataComplete = false; warnings.push(`Orca metadata incomplete: ${error.message}`); }
      const sessions = await scanRoots(roots || sessionRoots(home, state), project, warnings);
      const attempts = new Map();
      for (const worker of workers) {
        const task = tasks.get(worker.taskId);
        const roleLinks = Object.entries(state.agents).flatMap(([name, saved]) => [
          ...(saved.handle && saved.handle === worker.agentTerminalHandle ? [{ name, relation: 'worker', evidence: 'terminal-handle' }] : []),
          ...(saved.tabId && `${saved.tabId}:${saved.leafId}` === task?.created_by_pane_key ? [{ name, relation: 'creator', evidence: 'pane-key' }] : []),
        ]);
        attempts.set(worker.dispatchId, { taskId: worker.taskId, dispatchId: worker.dispatchId, runId: worker.runId,
          title: task?.task_title || task?.display_name || null, taskStatus: task?.status || null,
          dispatchStatus: worker.dispatchStatus, terminalState: worker.terminalState,
          workerHandle: worker.agentTerminalHandle, roles: [...new Set(roleLinks.map(link => link.name))], roleLinks, sessions: [], source: 'orca' });
      }
      for (const session of sessions) for (const marker of session.dispatches) {
        let attempt = attempts.get(marker.dispatchId);
        if (attempt && (attempt.taskId !== marker.taskId || attempt.workerHandle !== marker.workerHandle)) {
          warnings.push(`Dispatch metadata conflict: ${marker.dispatchId}`); continue;
        }
        if (!attempt) {
          attempt = { ...marker, runId: null, title: null, taskStatus: null, dispatchStatus: null,
            terminalState: null, roles: [], roleLinks: [], sessions: [], source: 'transcript-only' };
          attempts.set(marker.dispatchId, attempt);
        }
        for (const [name, saved] of Object.entries(state.agents)) if (saved.session?.id === session.id && saved.agent === session.provider && !attempt.roles.includes(name)) {
          attempt.roles.push(name);
          attempt.roleLinks.push({ name, relation: 'worker', evidence: 'session-id' });
        }
        attempt.sessions.push({ id: session.id, provider: session.provider, transcriptPath: session.transcriptPath, evidence: 'dispatch-preamble' });
      }
      // Retain older discoveries when Orca is offline or a transcript was moved/deleted.
      for (const old of previous?.tasks || []) {
        const current = attempts.get(old.dispatchId);
        if (!current) attempts.set(old.dispatchId, { ...old, cached: true });
        else {
          if (current.source === 'transcript-only' && old.source === 'orca') {
            Object.assign(current, { runId: old.runId, title: old.title, taskStatus: old.taskStatus,
              dispatchStatus: old.dispatchStatus, terminalState: old.terminalState, source: old.source, cached: true,
              roles: [...new Set([...old.roles, ...current.roles])], roleLinks: [...(old.roleLinks || []), ...current.roleLinks] });
          }
          for (const session of old.sessions) if (!current.sessions.some(item => item.transcriptPath === session.transcriptPath)) current.sessions.push({ ...session, cached: true });
        }
      }
      index = { version: 1, project, refreshedAt: new Date().toISOString(), metadataComplete, warnings,
        tasks: [...attempts.values()].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.dispatchId.localeCompare(b.dispatchId)) };
      saveJson(file, index);
    }
    if (!index) throw new Error('No history cache; run orca-team history first');
    return { ...index, cacheOnly: cached, indexPath: file,
      fixedRoles: Object.entries(state.agents).filter(([name]) => !role || role === name).map(([name, saved]) => ({
        name, session: saved.session || null, bindingSource: saved.bindingSource || 'legacy', pending: Boolean(saved.pending), lastVerifiedAt: saved.lastVerifiedAt || null })),
      tasks: index.tasks.filter(task => !role || task.roles.includes(role)).map(task => ({ ...task,
        sessions: task.sessions.map(session => ({ ...session, available: fs.existsSync(session.transcriptPath) })) })) };
  });
}
