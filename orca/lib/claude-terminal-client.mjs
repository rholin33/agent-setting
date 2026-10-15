import { randomUUID } from 'node:crypto';
import { openRuntimeConnection } from './remote-runtime.mjs';

export function localClaudeTitle(nativeTitle, label) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const activity = clean(nativeTitle).match(/^\s*([^\p{L}\p{N}\s]+)\s+/u)?.[1];
  return `${activity ? activity + ' ' : ''}${clean(label)}`;
}

// A terminal transport only: the existing remote PTY owns Claude and its history.
// Never starts/resumes an agent or retries a possibly delivered keystroke.
export async function connectRemoteTerminal({ pairing, target, WebSocket, nacl, onOutput, onTitle = () => {}, onClose = () => {}, viewport, timeoutMs = 15000 }) {
  const client = { id: `orca-team-${randomUUID()}`, type: 'desktop' };
  let subscriptionId, readyResolve, readyReject, connection;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A failed identity check can occur before the caller receives ready.
  ready.catch(() => {});
  const onFrame = frame => {
    if (frame.id !== subscriptionId) return;
    if (!frame.ok) throw new Error('Remote terminal subscription rejected');
    const event = frame.result;
    if (event.type === 'scrollback') {
      if (typeof event.serialized !== 'string') throw new Error('Remote terminal has no native screen snapshot');
      onOutput(event.serialized); readyResolve();
    } else if (event.type === 'data') onOutput(event.chunk);
    else if (event.type === 'end') connection.fail(new Error('Remote terminal stream ended; session retained'));
  };
  connection = await openRuntimeConnection({ pairing, runtimeId: target.runtimeId, WebSocket, nacl, timeoutMs, onFrame,
    onClose: error => { readyReject(error); onClose(error); } });
  const { request, close } = connection;
  try {
    await request('status.get', {});
    const inspect = async () => {
      const { terminal } = await request('terminal.show', { terminal: target.terminal });
      if (!terminal || terminal.handle !== target.terminal || terminal.incarnationId !== target.incarnation ||
        !terminal.connected || terminal.orphaned || terminal.worktreePath !== target.worktree ||
        (terminal.agentIdentity && terminal.agentIdentity !== 'claude')) throw new Error('Remote terminal identity changed');
      if (terminal.title) onTitle(terminal.title);
      return terminal;
    };
    await inspect();
    subscriptionId = connection.subscribe('terminal.subscribe',
      { terminal: target.terminal, client, viewport, capabilities: { desktopViewportClaims: 1 } });
    const readyTimer = setTimeout(() => connection.fail(new Error('Remote terminal snapshot timed out')), timeoutMs);
    ready.finally(() => clearTimeout(readyTimer)).catch(() => {});
    let inputTail = Promise.resolve();
    return {
      ready, close, inspect,
      send(text) {
        inputTail = inputTail.then(async () => {
          const result = await request('terminal.send', { terminal: target.terminal, text, client, viewport, claimViewport: true });
          if (!result.send?.accepted) throw new Error('Remote input was not accepted; nothing was retried');
        });
        return inputTail;
      },
      resize(next) {
        viewport = { cols: Math.max(20, Math.min(1024, next.cols)), rows: Math.max(8, Math.min(120, next.rows)) };
        return request('terminal.updateViewport', { terminal: target.terminal, client, viewport, claim: true });
      },
    };
  } catch (error) { close(); throw error; }
}
