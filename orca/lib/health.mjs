import { inspectMac } from './macos-health.mjs';
import { inspectWindows } from './windows-health.mjs';
import path from 'node:path';

export function provesSession(live, saved, platform = process.platform) {
  if (live.kind !== 'agent' || !saved.session?.id) return false;
  const normalize = file => platform === 'win32' ? path.win32.normalize(file).toLowerCase() : path.posix.normalize(file);
  return saved.agent === 'pi'
    ? typeof saved.session.transcriptPath === 'string' && live.sessionPaths?.some(file => normalize(file) === normalize(saved.session.transcriptPath)) === true
    : live.sessionIds?.includes(saved.session.id) === true;
}

const shells = /^(?:pwsh|powershell|bash|zsh|sh|fish|dash|cmd)(?:\.exe)?$/i;

export function classifyProcess(process, terminal, provider) {
  const evidence = process?.foregroundProcessEvidence;
  if (evidence?.verdict !== 'live' || evidence.ptyIncarnationId !== terminal.incarnationId ||
      !Number.isFinite(evidence.capturedAgeMs) || evidence.capturedAgeMs > 2000) return 'unverifiable';
  const name = (evidence.processName || process.foregroundProcess || '').split(/[\\/]/).at(-1);
  if (shells.test(name) && process.childProcessEvidence === 'no-children') return 'shell';
  if (new RegExp(`^${provider}(?:\\.exe)?$`, 'i').test(name)) return 'agent';
  return 'unverifiable';
}

export async function inspectHealth(cli, rpc, handle, provider, { platform = process.platform, nativeInspect = inspectWindows, macInspect = inspectMac } = {}) {
  const terminal = (await cli(['terminal', 'show', '--terminal', handle])).terminal;
  if (platform === 'win32' && terminal.executionHostId === 'local') {
    try { return await nativeInspect(terminal, provider, { show: async () => (await cli(['terminal', 'show', '--terminal', handle])).terminal }); }
    catch { return { terminal, kind: 'unverifiable', reason: 'windows_native_inspection_failed' }; }
  }
  const reply = await rpc('terminal.inspectProcess', {
    terminal: handle, expectedIncarnationId: terminal.incarnationId, scanChildProcesses: true,
  });
  const observed = reply.process;
  const kind = classifyProcess(observed, terminal, provider);
  const reason = observed?.foregroundProcessEvidence?.reason || observed?.reason || 'provider_not_proven';
  if (platform === 'darwin' && terminal.executionHostId === 'local' && kind !== 'shell') {
    try { return await macInspect(terminal, provider, { show: async () => (await cli(['terminal', 'show', '--terminal', handle])).terminal }); }
    catch { /* 仅在原生检查不可用时尝试 Orca 的运行状态证据。 */ }
  }
  // npm 包装启动的 CLI（包装脚本与 vendor 二进制同属一个前台进程组）会让 Orca 的进程栅栏
  // 返回 ambiguous_foreground_group，无法判定唯一前台进程。此时改用 Orca 自身的 agent 判定
  // 作为补充证据：它绑定当前 pty incarnation，且只把 unverifiable 升级为 agent，不会把 pane
  // 判成 idle shell，因此不会打开任何注入路径。
  if (kind === 'unverifiable' && reason === 'ambiguous_foreground_group') {
    // 旧版 Orca 没有该 RPC；缺失时保持原本的 unverifiable，不能因为补充证据不可用而中断检查。
    let status;
    try { status = await rpc('terminal.agentStatus', { terminal: handle }); } catch { status = null; }
    if (status?.agentStatus?.isRunningAgent === true) {
      return { kind: 'agent', terminal, reason: 'ambiguous_foreground_group_agent_status' };
    }
  }
  if (platform === 'darwin' && terminal.executionHostId === 'local' && kind !== 'shell' && kind !== 'agent') {
    return { terminal, kind: 'unverifiable', reason: 'macos_native_inspection_failed' };
  }
  return { kind, terminal, reason };
}

export async function recoverInPane({ name, saved, handle, command, cli, inspect, checkpoint, verifyBinding }) {
  const before = await inspect(handle, saved.agent);
  if (before.kind !== 'shell') throw new Error(`${name}: idle shell cannot be verified (${before.reason})`);
  // Reading the terminal immediately before send avoids pasting into a nonempty prompt.
  const screen = (await cli(['terminal', 'read', '--terminal', handle, '--limit', '2000'])).terminal;
  const last = (screen.tail || []).filter(line => line.trim()).at(-1)?.trim() || '';
  if (!/^(?:PS .+>|[^\n]*[$#%>]|➜ .+ [✗✔])$/.test(last)) throw new Error(`${name}: shell prompt is not empty`);
  const current = await inspect(handle, saved.agent);
  if (current.kind !== 'shell' || current.terminal.incarnationId !== before.terminal.incarnationId) {
    throw new Error(`${name}: process changed before resume`);
  }
  saved.pending = true;
  checkpoint();
  const receipt = await cli(['terminal', 'send', '--terminal', handle, '--text', command, '--enter']);
  if (receipt.send?.accepted !== true) throw new Error(`${name}: resume input was not confirmed; inspect pending state`);
  await verifyBinding();
  delete saved.pending;
  delete saved.restartIntent;
  checkpoint();
}
