# Orca SP configuration

`orca-sp` is the compact companion to `orca-team`. The configuration files are
`orca/sp-team.json`, `orca/sp-layout.json` and `orca/roles/sp-master.md`.
Runtime implementation and the detailed feature contract belong to the separate
`rholin33/orca-team` repository (`docs/features/orca-sp.md`).

## Default roles

| Role | CLI/model | Duties |
| --- | --- | --- |
| master | OMP native default model and thinking | Existing master duties plus authorized seat creation/dispatch |
| archi | OMP native default; existing remote Claude handoff | Existing archi duties |
| designer | OMP gemini-4-argon family resolved from local catalog | Existing frontend_engineer duties |

`modelSource: omp-default` resolves the local native settings rather than shipping
a model/provider catalog. `omp-gemini-4-argon` resolves an exact model ID, then the
available `gemini-4-argon-high` variant; ambiguity or absence fails explicitly.
The placeholder model names are never passed to OMP. Other providers, endpoints,
auth data and user defaults remain local.

When the native default is missing (`modelRoles: {}`), startup seeds only
`modelRoles.default`: reuse the saved local SP master selector when it still
exists in the local catalog, otherwise use the first locally declared model.
Existing defaults and other model roles are preserved; native settings are backed
up before writing. Inspection/export commands do not write native settings.
This SP bootstrap does not synchronize model catalogs or credentials.

## Master authorization and commands

The SP master may create a needed functional seat and dispatch through the live
Orca orchestration API without asking again for delegation permission. It must
inspect/reuse existing seats first and preserve active tasks, histories and
service terminals. Other approval rules continue to apply.

```text
orca-sp add-seat coder1 --role coder --thinking high
orca-sp start --group coder1 --no-pick
orca-sp remote --remote claude:archi --environment <paired-name>
```

Thinking is selected by master for task complexity. A new seat uses the current
OMP default model and its existing packaged specialty. Supported specialties:
coder, reviewer, test, simple, loader, deploy, copywriter, designer and archi.

## Persistence and publication

Generated profile state under `<team home>/profiles/sp` is local-only. The full
team's catalog, layout and project sessions are preserved. The two profiles cannot
simultaneously own panes in the same project because their canonical role names
overlap; the manager refuses that condition and retains both histories.

New runtime code must be published before advancing `orca/runtime.json`, then
configuration can be published. The published runtime pin and installation receipt
identify the complete installed snapshot. Earlier local test-install records and
backups remain local history. Model catalogs and saved presets are local-only;
neither publication nor synchronization transfers them.

## Verification (2026-11-11)

Runtime tests: 759 total, 749 passed, 10 platform skips, no failures. Native OMP
smoke resolved master/archi to `magpie/pay/gpt-6.1-sol` / high and designer to
`magpie/local/gemini-4-argon-high` / high. Profile initialization, seat registration
and configuration export passed without launching any real agent.

Runtime commit `2033074a18ca989584f7adc834b40e4aa1cf3448` includes SP startup,
shared Claude workspace preparation for every role and both team commands, and
strict original-intent handoff reconciliation. The complete 428-file runtime
export passed index and HEAD verification and was published before installation.
The complete configuration suite passed 50 checks, including 22 scope checks and
2 SP configuration checks.

Publication does not settle existing handoffs. The sewpg master/designer original
deliveries still require exact final acceptance; archi's historical receipt has a
payload mismatch and remains pending. Registry ownership, original sessions and
task ledgers are preserved. No agent is started or restarted for synchronization.
