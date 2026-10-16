// Remote ownership protects individual roles. Local siblings remain eligible for
// recovery, even when the remote proof fails, without moving their shared tab.
export async function recoverProtectedStart({ tabs, names, protectedNames, remote, reload, run, log = console.log }) {
  const failures = [];
  try { await remote(); }
  catch (error) { failures.push(`remote: ${error.message}`); log(`Remote recovery incomplete: ${error.message}`); }
  const localGroups = tabs.filter(tab => tab.agents.some(name => names.includes(name) && !protectedNames.has(name)));
  for (const tab of localGroups) {
    try {
      const result = await reload(tab.agents.filter(name => names.includes(name) && !protectedNames.has(name)));
      await run(tab.title, [...protectedNames]);
      failures.push(...result.skipped.map(item => `${item.name}: ${item.reason}`));
    } catch (error) { failures.push(`${tab.title}: ${error.message}`); }
  }
  log(`Protected handoffs retained; local role recovery checked in groups: ${localGroups.map(tab => tab.title).join(', ') || 'none'}.`);
  if (failures.length) throw new Error(`Startup recovery incomplete: ${failures.join('; ')}`);
}
