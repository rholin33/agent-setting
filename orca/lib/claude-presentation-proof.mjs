import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// 画面转发客户端不是本机 Claude；只接受当前窗格、进程和远端绑定都匹配的心跳。
export function provesClaudePresentation({ terminal, descendants, rows }, { now = Date.now() } = {}) {
  for (const row of rows.filter(row => descendants.has(row.ProcessId) && /^node\.exe$/i.test(row.Name))) {
    const words = (row.CommandLine || '').match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(word => word.replace(/^["']|["']$/g, '')) || [];
    const launcher = fileURLToPath(new URL('../bin/claude-remote-terminal.mjs', import.meta.url));
    const reconnect = words.length === 6 && words[4] === '--connection-id' && /^[0-9a-f-]{36}$/.test(words[5]);
    if ((words.length !== 4 && !reconnect) || path.resolve(words[1]).toLowerCase() !== launcher.toLowerCase() || words[2] !== '--config') continue;
    try {
      const file = path.resolve(words[3]), config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const status = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'local-terminal-status.json'), 'utf8'));
      const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'local-terminal.json'), 'utf8'));
      const age = now - Date.parse(status.updatedAt);
      if (reconnect && status.connectionId !== words[5]) continue;
      if (status.state === 'connected' && status.pid === row.ProcessId && age >= 0 && age < 25000 &&
          status.localPane === `${terminal.tabId}:${terminal.leafId}` && config.project === terminal.worktreePath &&
          status.project === config.project && status.role === config.role && status.runtimeId === config.runtimeId &&
          isDeepStrictEqual(status.remote, config.endpoint) && receipt.status === 'created' &&
          receipt.terminal.handle === terminal.handle && receipt.terminal.incarnationId === terminal.incarnationId) return true;
    } catch { /* 缺失或变化的证明保持不可验证。 */ }
  }
  return false;
}
