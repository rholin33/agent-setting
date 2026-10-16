// Native session metadata only. This does not submit a prompt or run a model.
export default function roleTitle(omp, env = process.env) {
  const name = env.ORCA_TEAM_ROLE;
  if (!/^[a-z][a-z0-9_]*$/.test(name || '')) return;
  omp.on('session_start', async () => { await omp.setSessionName(name); });
}
