# Factory Wizard — `/task new` Conversational Flow

> Design doc for the ask_user_question-driven task creation wizard.

## Principle

No upfront kind selection. The wizard asks questions to understand what the user
wants, classifies it, and creates the right work structure. Each classification
has rules the wizard follows.

## Conversation Flow

```
/task new
  ↓
Q1: "What do you want to do?"
    → free-text: user describes the idea/problem/task
  ↓
Q2: "Which domain does this belong to?"
    → select from discovered domains (snapjack, wolfpack, personal…)
  ↓
Q3: "What's the scope?" (agent classifies, but confirms with user)
    → One-off action (task)         — "I need to do X"
    → Something to investigate (spike) — "I need to figure out X"
    → A problem to fix (issue)       — "X is broken / wrong"
    → A capability to build (feature) — "I want to add X"
    → A larger effort (initiative)   — "I want to achieve X" (multiple features)
  ↓
  Based on classification:

  TASK:
    Q: "What does done look like?" → success_criteria (required)
    Q: "Area?" (optional, e.g. engineering, marketing)
    → creates 1 work item (kind: task)

  SPIKE:
    Q: "What question are you trying to answer?"
    Q: "Time box?" (optional)
    → creates 1 work item (kind: spike, success_criteria = question to answer)

  ISSUE:
    Q: "What's the expected behavior?"
    Q: "What's happening instead?"
    → creates 1 work item (kind: issue, success_criteria = expected behavior)

  FEATURE:
    Q: "What does done look like?"
    Q: "Area?"
    Q: "Want to break this into tasks now?" (optional)
      → if yes: loop creating child tasks (each with success_criteria)
    → creates 1+ work items (feature + child tasks)

  INITIATIVE:
    Q: "What's the goal?"
    Q: "Area?"
    Q: "What are the major pieces?" → creates child features
      → for each feature: "Break into tasks?" → child tasks
    → creates a work tree (initiative → features → tasks)

## Classification Rules (for agent-driven creation too)

Each kind has a prompt template stored in the work item body that guides
the agent when working on it:

- **task**: "Do X. Done when: {criteria}."
- **spike**: "Investigate: {question}. Time box: {timebox}. Deliver findings."
- **issue**: "Fix: {description}. Expected: {expected}. Actual: {actual}."
- **feature**: "Build: {description}. Done when: {criteria}. Tasks: {children}."
- **initiative**: "Goal: {goal}. Features: {children}."

## File Layout

Each work item gets its own .md file at `domains/<domain>/work/<WorkId>.md`.
Breaking down creates new files — the parent links via `partOf`.

## Future: Agent-Driven Classification

The wizard is the manual path. The `task_create` tool lets the agent create
work items directly when it has enough context (e.g. from a conversation where
the user described what they want). The agent should follow the same
classification rules.
