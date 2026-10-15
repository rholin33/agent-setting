import path from 'node:path';
import { normalizeProject } from './platform.mjs';
import { openRuntimeConnection, pairedEnvironment } from './remote-runtime.mjs';
import { terminalDependencies } from './claude-terminal-dependencies.mjs';

// 远端角色统一挂在远端主机的独立 Orca 项目下，而不是远端当前打开的任意项目：
// <远端用户目录>/Code/orca-remote/<调用方项目名>。路径风格由远端 runtime 报告，macOS/Linux/Windows 通用。
export const REMOTE_PROJECTS_SUBDIRECTORY = ['Code', 'orca-remote'];

// 调用方项目名取本机 Orca 登记的项目显示名；未登记时拒绝，不猜测名称。
export async function localProjectName({ project, cli }) {
  const target = normalizeProject(project).toLowerCase();
  const repos = (await cli(['repo', 'list'])).repos || [];
  const matches = repos.filter(repo => normalizeProject(repo.path).toLowerCase() === target);
  if (matches.length !== 1) throw new Error(`${project}: not a unique Orca project on this machine; cannot name its remote project`);
  const name = (matches[0].displayName || path.basename(matches[0].path)).trim();
  // Orca 的 repo.create 不接受含路径分隔符或 . / .. 的名称。
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`${project}: Orca project name "${name}" cannot be used as a remote folder name`);
  return name;
}

export function remoteProjectPath(home, name, flavor) {
  const join = flavor === 'win32' ? path.win32.join : flavor === 'posix' ? path.posix.join : null;
  if (!join) throw new Error(`Remote runtime reported an unknown path flavor: ${flavor}`);
  return join(home, ...REMOTE_PROJECTS_SUBDIRECTORY, name);
}

// 在远端 Orca 创建或复用该项目。repo.create 对已登记的同路径项目直接返回原项目；
// 目录已存在但非空且未登记时远端会拒绝，此时报告而不改用其他目录。
export async function ensureRemoteProject({ environment, project, cli, connect = openRuntimeConnection, dependencies = terminalDependencies, registry = pairedEnvironment }) {
  const name = await localProjectName({ project, cli });
  const { env, pairing } = registry(environment);
  const connection = await connect({ pairing, runtimeId: env.runtimeId, ...dependencies() });
  try {
    const home = await connection.request('files.browseServerDir', { path: '~' });
    if (!home?.resolvedPath) throw new Error(`${env.name}: remote home directory unavailable`);
    const remotePath = remoteProjectPath(home.resolvedPath, name, home.pathFlavor);
    const result = await connection.request('repo.create', { parentPath: path[home.pathFlavor].dirname(remotePath), name, kind: 'git' });
    const repo = result?.repo;
    if (!repo?.id) throw new Error(`${env.name}: remote project ${remotePath} was not created: ${result?.error || 'no repo returned'}`);
    if (path[home.pathFlavor].normalize(repo.path) !== remotePath) throw new Error(`${env.name}: remote project path mismatch (${repo.path} ≠ ${remotePath})`);
    return { environment: env.name, environmentId: env.id, runtimeId: env.runtimeId, name, path: repo.path, repoId: repo.id };
  } finally { connection.close(); }
}
