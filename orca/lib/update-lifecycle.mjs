import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './team.mjs';
import { restartRole, restartRoles } from './restart.mjs';

// Use the existing verified exit/resume path; never kill a process by name.
// Each stop persists restartIntent, so a crash retains the original binding.
export function updateLifecycle({ home, cli, snapshot, log = console.log, restart = restartRole }) {
  const runRecords = async (records, flags) => {
    const errors = [];
    const projects = [...new Set(records.map(record => record.project))];
    for (const project of projects) {
      const roles = records.filter(record => record.project === project).map(record => record.role);
      if (restart === restartRole && process.platform === 'win32') {
        const result = await restartRoles({ home, project, roles, cli, snapshot, log,
          concurrent: true, focus: async () => {}, ...flags });
        errors.push(...result.failed.map(item => `${item.name}: ${item.reason}`));
      } else for (const role of roles) {
        try { await restart({ home, project, role, cli, snapshot, log, ...flags }); }
        catch (error) { errors.push(`${role}: ${error.message}`); }
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  };
  return {
    async stop(agent) {
      const stopped = [];
      const inventory = await cli(['terminal', 'list']);
      if (inventory.truncated || inventory.hostScope?.omittedHostIds?.length) throw new Error('Global pane inventory is incomplete');
      try {
        const projectsDirectory = path.join(home, 'projects');
        const directories = fs.existsSync(projectsDirectory) ? fs.readdirSync(projectsDirectory) : [];
        for (const directory of directories) {
          const file = path.join(home, 'projects', directory, 'state.json');
          if (!fs.existsSync(file)) continue;
          const state = readJson(file);
          for (const [role, saved] of Object.entries(state.agents || {})) {
            if (saved.agent !== agent || !saved.session || !state.workspace) continue;
            const rows = inventory.terminals.filter(row => row.tabId === saved.tabId && row.leafId === saved.leafId && row.connected && !row.orphaned);
            if (rows.length !== 1) continue;
            const record = { project: state.workspace, role };
            stopped.push(record);
          }
        }
        await runRecords(stopped, { stopOnly: true, forceExit: true });
        return stopped;
      } catch (error) {
        const recoveryErrors = [];
        try { await runRecords(stopped, { forceExit: true }); }
        catch (recovery) { recoveryErrors.push(recovery.message); }
        if (recoveryErrors.length) throw new Error(`${error.message}; partial shutdown recovery failed: ${recoveryErrors.join('; ')}`);
        throw error;
      }
    },
    async resume(stopped) {
      await runRecords(stopped, {});
    },
  };
}
