# Predecessor Files

The original Windows installation remains untouched. Its files are mapped as follows:

| Original | Portable replacement |
| --- | --- |
| manage.ps1 | bin/orca-team.mjs and lib/team.mjs |
| orca-process.ps1 | lib/orca.mjs |
| session-resume.ps1 | lib/sessions.mjs |
| Nine role .ps1 launchers | Shared `launch --role NAME` command |
| Nine role .md files | roles/*.md, with TEAM_ROOT substituted locally |
| install.mjs / refresh.mjs | install command and runtime prompt rendering |
| PowerShell profile function | Generated bin/orca-team.ps1; POSIX bin/orca-team |
| layout.ps1, layout-receipts.json, adopt.mjs, repair-visible.mjs | Historical one-time helpers; not installed or replayed |
| quick-commands.json, quick-commands.before*.json | Recreated locally / retained only as local backups |

The 199 source files are copied without rewriting. Their original CCB-domain examples are preserved as role knowledge, not executed by the Orca installer. FILE-INVENTORY.json stores per-file SHA-256 hashes. Historical helpers and receipts are excluded because they contain machine-specific paths or runtime identifiers; this document preserves their purpose and replacement scope.
