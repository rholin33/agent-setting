import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { projectFiles, readJson, saveJson, withLock } from './team.mjs';
import { sameWorktree, validateTranscript } from './sessions.mjs';
import { restartRoles } from './restart.mjs';
import { mapLimit, INSPECT_CONCURRENCY } from './platform.mjs';

const MAX_HANDOFF_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOOL_CHARS = 200;
// 工具调用通常远多于对话消息；每段只保留最后几次调用，把预算留给对话本身。
const MAX_TOOLS_PER_BLOCK = 6;
// Codex 把 AGENTS.md、环境信息等注入为 user 消息，它们不属于对话内容。
const CODEX_INJECTED = /^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>)/;
const HEADINGS = { user: 'User', assistant: 'Assistant', summary: 'Compaction summary' };

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
const textOf = (content, types) => typeof content === 'string' ? content
  : (content || []).filter(item => types.includes(item.type)).map(item => item.text).join('\n');
const toolItem = (name, input) => ({ kind: 'tool', text: `${name} ${clip((typeof input === 'string' ? input : JSON.stringify(input ?? {})).replace(/\s+/g, ' '), MAX_TOOL_CHARS)}` });

// 每条记录归一为 { id, parent, items }；id/parent 用于沿当前分支回溯，排除回退/分叉后废弃的分支。
function normalize(row, provider) {
  if (['pi', 'omp'].includes(provider)) {
    const node = { id: row.id ?? null, parent: row.parentId ?? null, items: [] };
    if (row.type === 'compaction' && row.summary) node.items.push({ kind: 'summary', text: row.summary });
    if (row.type !== 'message') return node;
    const { role, content } = row.message;
    if (role === 'user') node.items.push({ kind: 'user', text: textOf(content, ['text']) });
    if (role === 'assistant') for (const item of content || []) {
      if (item.type === 'text') node.items.push({ kind: 'assistant', text: item.text });
      if (item.type === 'toolCall') node.items.push(toolItem(item.name, item.arguments));
    }
    return node;
  }
  if (provider === 'claude') {
    if (row.isSidechain) return null;
    const node = { id: row.uuid ?? null, parent: row.parentUuid ?? null, items: [] };
    const content = row.message?.content;
    if (row.type === 'user' && row.isCompactSummary) node.items.push({ kind: 'summary', text: textOf(content, ['text']) });
    else if (row.type === 'user' && !row.isMeta) node.items.push({ kind: 'user', text: textOf(content, ['text']) });
    if (row.type === 'assistant') for (const item of content || []) {
      if (item.type === 'text') node.items.push({ kind: 'assistant', text: item.text });
      if (item.type === 'tool_use') node.items.push(toolItem(item.name, item.input));
    }
    return node;
  }
  if (provider === 'codex') {
    const node = { id: null, parent: null, items: [] };
    const payload = row.payload || {};
    if (row.type === 'compacted' && payload.message) node.items.push({ kind: 'summary', text: payload.message });
    if (row.type !== 'response_item') return node;
    if (payload.type === 'message' && payload.role === 'user') {
      const text = textOf(payload.content, ['input_text']);
      if (!CODEX_INJECTED.test(text)) node.items.push({ kind: 'user', text });
    }
    if (payload.type === 'message' && payload.role === 'assistant') node.items.push({ kind: 'assistant', text: textOf(payload.content, ['output_text']) });
    if (payload.type === 'function_call') node.items.push(toolItem(payload.name, payload.arguments));
    if (payload.type === 'custom_tool_call') node.items.push(toolItem(payload.name, payload.input));
    if (payload.type === 'web_search_call') node.items.push(toolItem('web_search', payload.action));
    return node;
  }
  throw new Error(`Unsupported handoff provider: ${provider}`);
}

export async function readConversation(file, provider) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const nodes = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const node = normalize(JSON.parse(line.replace(/^﻿/, '')), provider);
      if (node) nodes.push(node);
    }
  } finally { lines.close(); input.destroy(); }
  const linked = nodes.filter(node => node.id);
  let chain = nodes;
  if (linked.length) {
    const byId = new Map(linked.map(node => [node.id, node]));
    chain = [];
    // Claude 压缩后的摘要记录 parent 为空，回溯自然止于最近一次压缩。
    for (let node = linked.at(-1); node; node = node.parent ? byId.get(node.parent) : null) chain.push(node);
    chain.reverse();
  }
  return chain.flatMap(node => node.items).filter(item => item.text?.trim());
}

// 连续工具调用合并为一个列表块，其余每条消息一个块。
function toBlocks(items) {
  const blocks = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.kind === 'tool' && last?.kind === 'tool') last.calls.push(item.text);
    else if (item.kind === 'tool') blocks.push({ kind: 'tool', calls: [item.text] });
    else blocks.push({ kind: item.kind, body: clip(item.text.trim(), MAX_MESSAGE_CHARS) });
  }
  for (const block of blocks) {
    if (block.kind !== 'tool') { block.text = `### ${HEADINGS[block.kind]}\n\n${block.body}`; continue; }
    const omitted = block.calls.length - MAX_TOOLS_PER_BLOCK;
    block.text = [...(omitted > 0 ? [`- …${omitted} earlier tool calls omitted`] : []), ...block.calls.slice(-MAX_TOOLS_PER_BLOCK).map(call => `- ${call}`)].join('\n');
  }
  return blocks;
}

export async function renderHandoff({ name, from, to, session, createdAt }) {
  const blocks = toBlocks(await readConversation(session.transcriptPath, from));
  // 从最新往前取，直到达到预算；若最近一次压缩摘要被截掉，单独置顶保留。
  const kept = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0 && used + blocks[index].text.length <= MAX_HANDOFF_CHARS; index--) {
    kept.unshift(blocks[index]);
    used += blocks[index].text.length;
  }
  const summary = blocks.findLast(block => block.kind === 'summary');
  const pinned = summary && !kept.includes(summary) ? [`## Latest compaction summary (before the excerpt below)\n\n${summary.body}`] : [];
  const omitted = blocks.length - kept.length;
  return [
    `# Orca role handoff: ${name} (${from} → ${to})`,
    [`- Created: ${createdAt}`, `- Source session: ${session.id}`, `- Source transcript: ${session.transcriptPath}`].join('\n'),
    `This is a mechanical extract of the role's previous ${from} conversation, which the ${to} CLI cannot resume. ` +
      'Tool outputs and reasoning are omitted and long messages are truncated. The source transcript can be very large: ' +
      'search it for specific details instead of reading it whole.',
    ...pinned,
    `## Conversation (${omitted ? `latest ${kept.length} of ${blocks.length} blocks; ${omitted} older blocks omitted` : `${blocks.length} blocks`})`,
    ...kept.map(block => block.text),
  ].join('\n\n') + '\n';
}

export function handoffPrompt(name, handoff) {
  return `Initialize the fixed ${name} role using the loaded instructions. This role previously ran on the ${handoff.from} CLI and that conversation cannot be resumed here. ` +
    `Read the handoff document ${handoff.path} now to restore its context. Then reply with "${name} ready" and a brief summary of the open work. Do not start or resume tasks until asked.`;
}

// 角色已停止：为旧会话生成交接文档并清除旧 CLI 的会话绑定，下次启动按新 CLI 新建会话并读取交接。
export async function prepareHandoff({ name, saved, to, directory, project, now = () => new Date() }) {
  if (saved.pending) throw new Error(`${name}: launch pending; rerun orca-team start to reconcile before switching CLI`);
  if (saved.session) {
    validateTranscript(saved, project);
    const createdAt = now().toISOString();
    const file = path.join(directory, 'handoff', `${name}-${saved.agent}-to-${to}-${createdAt.replace(/[:.]/g, '-')}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await renderHandoff({ name, from: saved.agent, to, session: saved.session, createdAt }));
    saved.handoff = { path: file, from: saved.agent, sessionId: saved.session.id, transcriptPath: saved.session.transcriptPath, createdAt };
  }
  for (const key of ['session', 'launchIntent', 'restartIntent', 'appliedModel']) delete saved[key];
  // 记录的 CLI 立即改为新 CLI：Orca 快照里该窗格的旧会话标注的是旧 CLI，不能再被当作恢复目标认领回来。
  saved.agent = to;
  return saved.handoff ?? null;
}

// 换 CLI：先按原 CLI 停止仍在运行的角色（不受配置指纹复用影响：此时目录里的配置可能已经是新 CLI），
// 全部确认回到 shell 后，再在项目锁内一次性写交接并清除旧会话绑定。
// 任一角色无法停止或验证时抛错且状态不变；下次启动会重新检测到同一切换并重试。
export async function switchProviders({ switches, home, project, cli, snapshot, inspect, log = console.log, restart = restartRoles }) {
  const files = projectFiles(home, project);
  const inspectAll = async state => {
    const terminals = (await cli(['terminal', 'list', '--worktree', `path:${project}`])).terminals || [];
    return mapLimit(switches, INSPECT_CONCURRENCY, async ({ name }) => {
      const saved = state.agents[name];
      const row = terminals.find(item => item.tabId === saved.tabId && item.leafId === saved.leafId &&
        item.connected && !item.orphaned && sameWorktree(`local::${item.worktreePath}`, project));
      return { name, agent: saved.agent, live: row ? await inspect(row.handle, saved.agent) : null };
    });
  };
  const before = await inspectAll(readJson(files.state));
  const unverifiable = before.filter(item => item.live && !['agent', 'shell'].includes(item.live.kind));
  if (unverifiable.length) throw new Error(`Cannot switch CLI: ${unverifiable.map(item => `${item.name}: ${item.agent} pane is ${item.live.kind}`).join('; ')}`);
  const running = before.filter(item => item.live?.kind === 'agent').map(item => item.name);
  if (running.length) {
    log(`Stopping ${running.join(', ')} with the current CLI before switching`);
    const { failed } = await restart({ home, project, roles: running, stopOnly: true, forceExit: true, cli, snapshot, log });
    if (failed.length) throw new Error(`Cannot switch CLI: ${failed.map(item => `${item.name}: ${item.reason}`).join('; ')}`);
  }
  await withLock(files.lock, async () => {
    const state = readJson(files.state);
    const after = await inspectAll(state);
    const busy = after.filter(item => item.live && item.live.kind !== 'shell');
    if (busy.length) throw new Error(`Cannot switch CLI: ${busy.map(item => `${item.name}: ${item.agent} pane is ${item.live.kind}`).join('; ')}`);
    for (const { name, to } of switches) {
      const saved = state.agents[name];
      const from = saved.agent, hadSession = Boolean(saved.session);
      const handoff = await prepareHandoff({ name, saved, to, directory: files.directory, project });
      log(`${name}: switching CLI ${from} → ${to}; ${hadSession ? `handoff written to ${handoff.path}` : 'no previous conversation to hand off'}`);
    }
    saveJson(files.state, state);
  });
}

// 已保存会话所用的 CLI 与目录配置不同的角色需要换 CLI；与 picker 无关，失败后下次启动会再次检测到。
export function pendingSwitches(state, catalog, names) {
  return names.flatMap(name => {
    const saved = state.agents?.[name], role = catalog.find(item => item.name === name);
    return saved && role && (saved.session || saved.launchIntent) && saved.agent !== role.agent ? [{ name, from: saved.agent, to: role.agent }] : [];
  });
}

// Remote handoffs own both their source and original return conversation. A model
// catalog update must not migrate either local CLI before the handoff is settled.
export function startupSwitches(state, catalog, names, continuity, requests) {
  const protectedNames = new Set(requests.map(item => item.role));
  for (const name of names) {
    if (continuity.roles[name]?.runtime || continuity.roles[name]?.pending) protectedNames.add(name);
  }
  return pendingSwitches(state, catalog, names.filter(name => !protectedNames.has(name)));
}
