---
name: md-doc
description: >
  Use when planning, implementing, or finishing a standalone feature so the
  repo always gets a complete markdown feature document. Trigger especially in
  two moments: before presenting a plan for a feature, and again before
  finalizing or handing off completed feature work.
---

# md-doc

Create or update a feature markdown document for any standalone feature.

## When to use

Use this skill whenever work is centered on a distinct feature, workflow, module, or cross-layer change that should be documented for future engineers or agents.

Mandatory checkpoints:

1. Before presenting a feature plan or decision-complete implementation approach, create or refresh the document skeleton.
2. Before finalizing implementation, update the same document with the actual delivered behavior, interfaces, verification, and known gaps.

If a feature already has a document, update it instead of creating a duplicate.

## Document location

Prefer these paths in order:

1. `docs/features/<feature-slug>.md`
2. `docs/<feature-slug>.md` if the repo has no `docs/features/`

Use a short, stable slug. Reuse the same file through the whole feature lifecycle.

## Minimum document structure

Every feature document should contain:

- Title
- Feature overview
- Supported capabilities or user flow
- Backend design or API changes if applicable
- Frontend interaction/state changes if applicable
- Data model or persistence changes if applicable
- Verification status
- Known limitations or follow-up items

## Planning-phase pass

Before presenting the plan:

- Create the document if missing.
- Fill in overview, scope, user flow, intended APIs, state machine or key states, data model expectations, and planned validation.
- Mark uncertain items clearly as assumptions.
- Keep the document factual and implementation-oriented.

## Pre-finish pass

Before sending the final completion message:

- Update the same document with what was actually implemented.
- Replace planned text that is no longer true.
- Add final route names, event names, file locations, verification commands, and known issues.
- Record any deliberate deferrals.

## Quality rules

- Do not write vague product prose.
- Prefer concrete behavior, contracts, and engineering facts.
- Keep the doc readable by a future engineer who did not participate in the task.
- Do not claim something is implemented unless it exists in the repo.
- If verification is partial, state exactly what passed and what did not.
