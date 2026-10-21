import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

async function askGitInit(project) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`目录 ${project} 尚未初始化 Git。是否执行 git init 后注册 Orca 并继续启动？仅创建 Git 元数据，不提交或推送文件。[y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally { prompt.close(); }
}

export async function confirmGitInit(project, {
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm = askGitInit,
  runGit = args => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  try {
    runGit(['rev-parse', '--git-dir']);
    return false;
  } catch (error) {
    // Missing Git, unsafe ownership and damaged repositories must not trigger init.
    if (!/not a git repository/i.test(String(error.stderr || ''))) throw error;
  }
  if (!interactive) throw Object.assign(new Error(`目录 ${project} 不是 Git 仓库。请在交互终端运行 orca-team，确认是否执行 git init；当前未修改目录。`), { code: 'STARTUP_CANCELLED' });
  if (await confirm(project) !== true) throw Object.assign(new Error('已取消 Git 初始化和团队启动；未修改目录。'), { code: 'STARTUP_CANCELLED' });
  runGit(['init']);
  return true;
}

// Only a proven missing selector for this project authorizes registration.
export async function projectInventory({ project, cli, register = false, visualLayouts = false, initGit = confirmGitInit }) {
  const selector = `path:${project}`;
  const list = () => cli(['terminal', 'list', '--worktree', selector,
    ...(visualLayouts ? ['--include-visual-layouts'] : [])]);
  try { return await list(); } catch (error) {
    if (!register || error.code !== 'selector_not_found' || error.selector !== selector) throw error;
    try { await cli(['repo', 'add', '--path', project]); } catch (registrationError) {
      if (!registrationError.message?.startsWith('Not a valid git repository:')) throw registrationError;
      if (!await initGit(project)) throw registrationError;
      await cli(['repo', 'add', '--path', project]);
    }
    return list();
  }
}
