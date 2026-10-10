# Factory Wizard — `/task` → create

> The guided flow for creating a work item from the `/task` dashboard
> (`wizardNew` in `extensions/wolfpack-memory/work-system.ts`). The agent's
> equivalent is the `task_create` tool. Work item model: `docs/factory-design.md`.

## Principle
No upfront kind selection by jargon. The wizard asks what you want to do and
classifies it from plain-language choices.

## Flow (as built)
```
1. "What do you want to do?"      free text → description
2. "Which domain?"                discovered KB domains + personal
                                  (skipped when there is only one)
3. "What best describes this?"
     A one-off action I need to do         → task
     Something to investigate or research  → spike
     A problem or bug to fix               → issue
     A capability to build                 → feature
     A larger effort with multiple parts   → initiative
4. "Title"                        defaults to the description
→ creates one work item (assignee = this wolf) with a starter body
```

Starter bodies by kind:

| Kind | Body sections |
|---|---|
| task | `## Plan` (description), `## Done when` |
| spike | `## Question` (description), `## Findings` |
| issue | `## Problem` (description), `## Expected behavior`, `## Fix` |
| feature | `## Overview` (description), `## Plan`, `## Done when` |
| initiative | `## Goal` (description), `## Features`, `## Plan` |

Binding an item then offers: **Start working**, **Review and update the plan**
(the wolf reviews the working document with you), or **Change title or success
criteria**. A task needs `successCriteria` before it can leave `plan`.

## Not built yet (original design)
- **Per-kind follow-ups:** task → "What does done look like?" (sets
  `successCriteria`) and "Area?"; spike → the question + a time box; issue →
  expected vs. actual behavior.
- **Breakdown loops:** feature → "Break this into tasks now?"; initiative → "What
  are the major pieces?" creating child features, each optionally broken into
  tasks.
- **Agent-driven classification** following the same rules from conversation
  context (today the agent picks `kind` itself when calling `task_create`).
