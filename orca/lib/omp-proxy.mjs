import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const internetSettings = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const proxyVariables = new Set(['PI_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']);

export function ompProxyFingerprint(options = {}) {
  const env = { ...(options.env ?? process.env), ...ompProxyEnvironment(options) };
  const values = Object.entries(env).filter(([key, value]) =>
    /^(?:PI_PROXY(?:_.*)?|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key) && typeof value === 'string' && value.trim())
    .sort(([a], [b]) => a.localeCompare(b));
  // 只保存摘要，代理地址中的账号密码不得写入项目状态。
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function proxyUrl(server) {
  let address = server.trim();
  // Windows 的 https= 指目标协议，未标注代理协议的地址仍使用 HTTP CONNECT。
  if (/^(?:http|https|ftp|socks)\s*=/i.test(address)) {
    const entries = Object.fromEntries(address.split(';').map(entry => {
      const split = entry.indexOf('=');
      return [entry.slice(0, split).trim().toLowerCase(), entry.slice(split + 1).trim()];
    }));
    address = entries.https || entries.http || '';
  }
  if (!address || /[\s\x00-\x1f;]/.test(address)) return null;
  try {
    const url = new URL(address.includes('://') ? address : `http://${address}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

export function ompProxyEnvironment({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  // 显式环境配置交给 OMP 自己按优先级解析；不改父进程或持久化配置。
  const explicit = Object.entries(env).some(([key, value]) =>
    proxyVariables.has(key.toUpperCase()) && typeof value === 'string' && value.trim());
  if (platform !== 'win32' || explicit) return {};
  try {
    // 每次启动重新读取，避免 Orca 或旧终端缓存了已经切换/关闭的系统代理。
    const registry = run(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', internetSettings], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const enabled = registry.match(/^\s*ProxyEnable\s+REG_DWORD\s+(\S+)/im)?.[1];
    if (Number(enabled) !== 1) return {};
    const server = registry.match(/^\s*ProxyServer\s+REG_SZ[^\S\r\n]+([^\r\n]*)/im)?.[1];
    const proxy = server ? proxyUrl(server) : null;
    return proxy ? { PI_PROXY: proxy } : {};
  } catch {
    // 系统代理不可读取时保留原有启动行为，不能阻止会话恢复。
    return {};
  }
}
