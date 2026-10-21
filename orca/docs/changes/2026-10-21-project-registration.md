# First-project registration repair (2026-10-21)

Startup must resolve/register the exact project before its first terminal inventory,
including reveal, reload and layout recovery. A selector_not_found error only permits
registration if its selector equals the requested path. Other errors are propagated;
registration is never automatically retried after an uncertain failure. Status is read-only.

The shared projectInventory helper is used by startup and runTeam. Existing template
selection remains project override, generated config, default layout. No Git repository
is initialized implicitly. Orca repo add currently rejects non-Git directories.

Validation: 488 tests, 478 passed, 10 skipped, zero failures; entry syntax check passed.
Live retry in D:/Code/wps_abil reached registration but was blocked by the absence of
Git metadata. No roles were started. Exact original scripts are in
backups/new-project-registration-20261021/.

## Non-Git directory confirmation

When Orca rejects registration as not a valid Git repository, verify the directory
with git rev-parse --git-dir. Only Git's explicit not-a-repository failure permits
an initialization prompt. Missing Git, unsafe ownership and other failures propagate.
Interactive startup asks [y/N] with the exact path; only y/yes performs git init,
then retries registration once. No commit or push is performed. Declining or running
without a TTY cancels startup without opening a repair agent or modifying the directory.

Validation: 495 tests, 485 passed, 10 skipped, zero failures. Real noninteractive
startup returned the confirmation guidance and D:/Code/wps_abil still has no .git.
