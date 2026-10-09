import { spawnSync } from 'node:child_process';
export function supportsNoDaemon(run = spawnSync) {
  const reply = run('codex', ['--help'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return reply.status === 0 && /(?:^|\s)--no-daemon(?:\s|$)/m.test(reply.stdout || '');
}
