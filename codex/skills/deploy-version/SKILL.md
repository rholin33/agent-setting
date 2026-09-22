---
name: deploy-version
description: Draft, iterate, and finalize release notes for version upgrades, deployments, launches, and changelog requests based on the current local code changes. Use when the user mentions upgrading a version, publishing, deploying, releasing, going live, writing update logs, or asks Codex to summarize workspace changes into a confirmed release note saved to disk.
---

# Deploy Version

## Overview

Draft release notes from the current workspace, review them with the user, and save the confirmed version to the local release-note files used by the project UI.

## Workflow

### 1. Inspect local changes first

- Read `git status --short`, `git diff --stat`, and the specific changed files before writing release notes.
- Base every changelog item on code or content that actually exists in the workspace.
- Call out inference explicitly when the diff only implies a user-facing change.

### 2. Build a reviewable draft

- Draft in Chinese by default when the surrounding request is in Chinese.
- Every release-note draft must include these blocks in order:
  - Version identifier
  - Release title
  - One-sentence summary
  - 当前更新内容
  - Roadmap
- Keep the summary extremely short by default. Prefer a brief noun phrase or a compact clause such as `大纲生成优化，文件格式支持`.
- Historical records are maintained in `data/release-notes/index.json`; the newest confirmed entry becomes the current update and older confirmed entries become the history feed automatically.
- Keep wording user-facing. Lead with outcome, not implementation trivia.

### 3. Review with the user before saving

- Show the draft in chat before writing final files.
- Invite edits to scope, tone, ordering, omissions, and naming.
- Iterate until the user explicitly confirms the final wording.
- Do not treat silence as approval.

### 4. Save the confirmed release note

- Read [references/release-note-schema.md](./references/release-note-schema.md) before writing files.
- Save the Markdown note to `data/release-notes/YYYY-MM-DD-<slug>.md`.
- Update `data/release-notes/index.json` so the newest entry is first in the UI feed.
- Keep Markdown and JSON content aligned after every confirmed update.

### 5. Protect confirmed history

- Do not overwrite an existing confirmed release note unless the user asks.
- If the user wants another revision after saving, either update both the Markdown and JSON entry together or create a clearly marked new draft and say which file is provisional.

## Output Rules

- Include only changes that matter to users, operators, or collaborators.
- Separate shipped functionality from planned follow-up by using `当前更新内容` and `Roadmap` as different sections.
- Do not pad the summary with background explanation unless the user explicitly asks for more detail.
- Use exact file paths when telling the user where the release note was saved.
- If no meaningful product change exists, say so instead of fabricating a changelog.
