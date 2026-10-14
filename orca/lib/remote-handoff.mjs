import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConversation } from './handoff.mjs';
import { projectFiles, readJson } from './team.mjs';
import { pythonCommand } from './platform.mjs';
import { validateTranscript } from './sessions.mjs';
import { claimRemoteSetup, commitRemoteSwitch, rejectRemoteSwitch, readRemoteSwitches } from './remote-switch.mjs';
import { verifyOmpBinding } from './omp-adapter.mjs';

const execute = promisify(execFile);
const POLL_MS = 1000;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000;
// handoff.py 拒绝超过 24 KiB 的摘要；留出 JSON 结构余量。
const SUMMARY_BUDGET_BYTES = 20 * 1024;
const MAX_ITEM_CHARS = 2000;
const MAX_CHANGED_FILES = 100;
const DECISION = /\bHANDOFF_(ACCEPTED|REJECTED)\b/g;
// 只认唯一明确的决定；同时出现接受和拒绝（例如复述指令）不算回执。
export function decisionOf(text) {
  const found = new Set([...text.matchAll(DECISION)].map(match => match[1]));
  return found.size === 1 ? (found.has('ACCEPTED') ? 'accepted' : 'rejected') : null;
}

const clip = text => text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text;
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// 确定性交接只覆盖能读到真实助手回复的端点：本机会话记录与远端 OMP 控制服务。
// 远端 Codex 的对话在远端主机上，仍交给 AI 协调者。
export function supportsDirectHandoff(intent, registry) {
  return (intent.runtime === null || intent.runtime === 'omp') && registry.roles[intent.role]?.runtime !== 'codex';
}

function controlRequest(adapterConfig, route, body) {
  const state = readJson(adapterConfig);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: state.peer, port: state.base + 3, path: route, method: payload ? 'POST' : 'GET', timeout: 20000,
      headers: { Authorization: `Bearer ${state.control_token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`OMP control ${route} failed (${response.statusCode})`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`OMP control ${route} returned invalid JSON`)); }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`OMP control ${route} timed out`)));
    request.on('error', reject);
    request.end(payload);
  });
}

// 端点通道：读取助手回复、判断忙闲。位置是不透明值，用于只取投递之后的新回复。
export function remoteOmpChannel(adapterConfig, request = controlRequest) {
  const read = async from => {
    const messages = [];
    let offset = from;
    for (;;) {
      const page = await request(adapterConfig, '/messages', { offset });
      messages.push(...page.messages.filter(item => item.role === 'assistant').map(item => ({ kind: 'assistant', text: item.text })));
      if (page.nextOffset === offset) return { items: messages, position: offset };
      offset = page.nextOffset;
    }
  };
  return {
    kind: 'remote-omp',
    position: async () => (await read(0)).position,
    since: async position => (await read(position)).items,
    all: async () => (await read(0)).items,
    busy: async () => {
      const busy = (await request(adapterConfig, '/snapshot')).host?.busy;
      if (typeof busy !== 'boolean') throw new Error('Remote OMP busy state is unavailable');
      return busy;
    },
  };
}

export function localChannel({ transcriptPath, runtime, terminal, cli }) {
  const items = () => readConversation(transcriptPath, runtime);
  return {
    kind: 'local',
    position: async () => (await items()).length,
    since: async position => (await items()).slice(position),
    all: items,
    busy: async () => {
      let reply = null;
      try { reply = await cli(['terminal', 'wait', '--terminal', terminal, '--for', 'tui-idle', '--timeout-ms', '2000']); }
      catch (error) { if (error.message !== 'timeout') throw error; }
      return reply?.wait?.satisfied !== true;
    },
  };
}

// 本机端点必须对应该角色已保存并通过校验的原生会话记录。
function localTranscript(home, project, role, endpoint) {
  const saved = readJson(projectFiles(home, project).state).agents?.[role];
  if (!saved?.session || saved.session.id !== endpoint.session || saved.agent !== endpoint.runtime) {
    throw new Error(`${role}: no saved transcript for local session ${endpoint.session}`);
  }
  validateTranscript(saved, project);
  return saved.session.transcriptPath;
}

function channelFor({ home, project, role, endpoint, adapterConfig, cli, request }) {
  if (adapterConfig) return remoteOmpChannel(adapterConfig, request);
  return localChannel({ transcriptPath: localTranscript(home, project, role, endpoint), runtime: endpoint.runtime, terminal: endpoint.terminal, cli });
}

async function draftEmpty(cli, terminal) {
  const screen = (await cli(['terminal', 'read', '--terminal', terminal, '--screen'])).terminal;
  return screen.source === 'screen' && (screen.draft === undefined || screen.draft === null || screen.draft === '');
}

async function changedFiles(project, run = execute) {
  const { stdout } = await run('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], { maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split('\n').filter(Boolean);
  return [...lines.slice(0, MAX_CHANGED_FILES), ...(lines.length > MAX_CHANGED_FILES ? [`…${lines.length - MAX_CHANGED_FILES} more paths (git status)`] : [])];
}

// 机械检查点：从源会话提取，不再请求源角色额外回合。字段满足 handoff.py 的结构校验。
export function mechanicalSummary({ items, previousGoal, changed, sourceLabel }) {
  const users = items.filter(item => item.kind === 'user').slice(-3).map(item => clip(item.text.trim()));
  const goal = users.length ? `Continue the work from the latest requests in ${sourceLabel}:\n${users.join('\n---\n')}` : previousGoal;
  if (!goal?.trim()) throw new Error('Source conversation has no request to hand off');
  const summary = {
    goal,
    constraints: [
      `Mechanical checkpoint extracted from ${sourceLabel}; tool outputs and reasoning are omitted.`,
      'Re-read files before editing: the working tree may have changed since these messages.',
      'Receiving this context does not authorize running pending work; wait for the user to continue.',
    ],
    completed: [],
    changed_files: changed,
    decisions: [],
    verification: ['Earlier verification results were not extracted; re-run relevant checks before relying on them.'],
    pending: ['Confirm the next step with the user before continuing the work.'],
    inflight: [],
  };
  for (const item of items.filter(item => item.kind === 'assistant' || item.kind === 'summary').reverse()) {
    const entry = clip(item.text.trim());
    if (bytes({ ...summary, completed: [entry, ...summary.completed] }) > SUMMARY_BUDGET_BYTES) break;
    summary.completed.unshift(entry);
  }
  return summary;
}

function ledgerHelper({ skill, python }) {
  const script = path.join(path.dirname(skill), 'scripts', 'handoff.py');
  return async (action, ledgerDirectory, { input, taskId, message } = {}) => {
    let file;
    try {
      const args = [script, action, '--state-dir', ledgerDirectory];
      if (input !== undefined) {
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-handoff-')), 'input.json');
        fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
        args.push('--input', file);
      }
      if (taskId) args.push('--task-id', taskId);
      if (message) args.push('--message');
      const { stdout } = await execute(python, args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return message ? stdout.replace(/\n$/, '') : JSON.parse(stdout);
    } catch (error) {
      throw new Error(`handoff.py ${action} failed: ${(error.stderr || error.message).trim()}`);
    } finally {
      if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  };
}

const deliveryFile = (ledgerDirectory, recordId) => path.join(ledgerDirectory, `${recordId}.delivery.json`);

function ledgerState(ledgerDirectory) {
  const file = path.join(ledgerDirectory, 'state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/**
 * 不经过 AI 协调者完成一次交接：机械检查点 → prepare/claim → 投递一次 → 读取真实助手回执 →
 * accept → remote-commit/remote-reject。投递之后的任何失败都保留 delivery_uncertain 与投递位置，
 * 再次运行只继续等待回执，绝不重发。
 */
export async function runDirectHandoff({ home, project, role, intent, sourceAdapterConfig, cli, skill, log = console.log,
  python = pythonCommand(), request = controlRequest, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, timeoutMs = REPLY_TIMEOUT_MS, verifyOmp = verifyOmpBinding, git = execute, ledger = ledgerHelper({ skill, python }) }) {
  const targetEndpoint = intent.runtime === null ? intent.local : intent.target;
  const source = channelFor({ home, project, role, endpoint: intent.source, adapterConfig: sourceAdapterConfig, cli, request });
  const target = channelFor({ home, project, role, endpoint: targetEndpoint, adapterConfig: intent.runtime === 'omp' ? intent.adapterConfig : undefined, cli, request });
  const existing = ledgerState(intent.ledgerDirectory)[intent.taskId];
  const resumed = existing?.revision === intent.baseRevision + 1 && existing.status === 'delivery_uncertain' && existing.id !== intent.baseRecordId;
  let record, position;
  if (resumed) {
    record = existing;
    const delivery = deliveryFile(intent.ledgerDirectory, record.id);
    if (!fs.existsSync(delivery)) throw new Error(`${role}: delivery position was not recorded; inspect the target before settling`);
    position = JSON.parse(fs.readFileSync(delivery, 'utf8')).position;
    log(`${role}: resuming the wait for the handoff receipt (revision ${record.revision}); nothing is resent`);
  } else {
    // 投递前的检查失败不改变归属，由调用方取消未领取的意图。
    if (sourceAdapterConfig) await verifyOmp({ home, project, role, config: sourceAdapterConfig, endpoint: intent.source });
    if (intent.runtime === 'omp') await verifyOmp({ home, project, role, config: intent.adapterConfig, endpoint: intent.target });
    if (await source.busy()) throw new Error(`${role}: source agent is busy; retry after its turn completes`);
    if (await target.busy()) throw new Error(`${role}: target agent is busy; retry after its turn completes`);
    if (!await draftEmpty(cli, targetEndpoint.terminal)) throw new Error(`${role}: target input is not empty; nothing was sent`);
    const previous = intent.baseRecordId ? ledgerState(intent.ledgerDirectory)[intent.taskId] : null;
    // 远端 OMP 只暴露助手消息：从上次交接投递位置之后取远端新进展，目标沿用上次记录。
    const forward = previous && sourceAdapterConfig ? deliveryFile(intent.ledgerDirectory, previous.id) : null;
    const items = forward && fs.existsSync(forward) ? await source.since(JSON.parse(fs.readFileSync(forward, 'utf8')).position) : await source.all();
    const summary = mechanicalSummary({ items, previousGoal: previous?.summary?.goal, changed: await changedFiles(project, git),
      sourceLabel: `${intent.source.runtime} ${role} (${sourceAdapterConfig ? 'remote' : 'local'})` });
    const fields = ['runtime', 'role', 'environment', 'terminal', 'incarnation', 'session'];
    const pick = endpoint => Object.fromEntries(fields.map(key => [key, endpoint[key]]));
    const prepared = await ledger('prepare', intent.ledgerDirectory, { input: { task_id: intent.taskId, worktree: project, source: pick(intent.source), target: pick(targetEndpoint), summary } });
    await claimRemoteSetup({ home, project, role, intentId: intent.id });
    await ledger('claim', intent.ledgerDirectory, { input: pick(targetEndpoint), taskId: intent.taskId });
    record = ledgerState(intent.ledgerDirectory)[intent.taskId];
    if (record.id !== prepared.id) throw new Error(`${role}: handoff ledger changed during preparation`);
    position = await target.position();
    fs.writeFileSync(deliveryFile(intent.ledgerDirectory, record.id), JSON.stringify({ position, terminal: targetEndpoint.terminal, at: new Date(now()).toISOString() }), { mode: 0o600 });
    const text = await ledger('show', intent.ledgerDirectory, { taskId: intent.taskId, message: true });
    const sent = await cli(['terminal', 'send', '--terminal', targetEndpoint.terminal, '--text', text, '--enter', '--wait-submit', '5']);
    if (sent.send?.accepted !== true) throw new Error(`${role}: handoff delivery is unconfirmed (revision ${record.revision}); rerun to wait for the receipt, it is never resent`);
    log(`${role}: handoff revision ${record.revision} delivered; waiting for the target's acceptance`);
  }
  const deadline = now() + timeoutMs;
  let reply;
  while (!reply) {
    const decided = (await target.since(position)).filter(item => item.kind === 'assistant' && decisionOf(item.text) &&
      (item.text.includes(record.id) || item.text.includes(record.sha256)));
    if (decided.length && !await target.busy()) reply = decided.at(-1).text;
    else if (now() > deadline) throw new Error(`${role}: no handoff receipt yet (revision ${record.revision}); the delivery stays pending — rerun the same switch to keep waiting, it is never resent`);
    else await sleep(POLL_MS);
  }
  const decision = decisionOf(reply);
  await ledger('accept', intent.ledgerDirectory, { taskId: intent.taskId,
    input: { origin: 'assistant_turn', decision, target: record.target, id: record.id, sha256: record.sha256, reply } });
  const settle = decision === 'accepted' ? commitRemoteSwitch : rejectRemoteSwitch;
  await settle({ home, project, role, intentId: intent.id, cli, verifyOmp });
  if (decision === 'accepted') await cli(['terminal', 'switch', '--terminal', targetEndpoint.terminal]);
  log(`${role}: handoff ${decision} by the target (revision ${record.revision})${decision === 'accepted' ? '; now the owner' : '; source keeps the task'}`);
  return { decision, revision: record.revision, owner: readRemoteSwitches({ home, project }).roles[role]?.owner };
}
