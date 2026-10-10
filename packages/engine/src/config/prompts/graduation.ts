/**
 * Graduation prompts — appended to PRODUCE_SYSTEM when the sweep produces an
 * entry from graduated Factory work. The Factory is live work; the KB is past
 * tense. These turn a work dossier (plan, task notes) into knowledge that reads
 * as a record of what exists, with no trace of the work process.
 */

/** Shared rules: what never leaves the Factory. */
const NO_FACTORY_TRACE = `NEVER INCLUDE (these belong to the task system, not the knowledge base):
- task lists, checklists, stages, statuses, plans, "next steps", TODOs, open questions
- work item ids (work-<domain>-<id>), task titles as headings, commit hashes
- test counts or results anywhere, even in parentheses ("(11 tests)", "224/224")
- process narration ("we started by…", "then the task was…", "this feature will…")
- remaining or in-progress work`;

/**
 * stage: produce (graduation · feature) · in: feature dossier · out: past-tense entry
 */
export const GRADUATE_FEATURE_RULES = `GRADUATION — FEATURE ENTRY
The contribution is a dossier for a FINISHED feature: its plan document and the
notes of the tasks that built it. Write the knowledge that remains now that the
work is done. Past tense for what was built and decided; present tense for how
it works today.

The detail covers, as applicable:
- What exists: the capability, in one or two sentences.
- How it works: the mechanisms, rules and behaviour a reader needs.
- Key decisions and their reasons (including options that were rejected).
- Where it lives: file paths, functions, commands, config knobs — verbatim.

${NO_FACTORY_TRACE}

Pick the kind that fits the feature (architecture, process, decision, product…).
The summary is one line naming what exists, not what was done.`;

/**
 * stage: produce (graduation · initiative hub) · in: initiative goal + graduated features · out: hub entry
 */
export const GRADUATE_HUB_RULES = `GRADUATION — INITIATIVE HUB ENTRY
The contribution describes an initiative and the features of it that have been
delivered so far. Write a short hub entry that introduces the initiative and
points to each delivered feature's own entry. The hub holds NO feature detail:
that lives in the feature entries.

The detail is:
- One short paragraph: what the initiative is for (its goal), in present tense.
- "Delivered": one or two past-tense lines per delivered feature, each starting
  with the feature's [[entry-id]] wikilink exactly as given in the contribution.
- Only if the contribution marks the initiative COMPLETE: a short "Outcome"
  paragraph summarising what the initiative achieved as a whole.

The hub lists ONLY delivered features. Never mention counts ("3 of 7"), features
not listed, remaining work, or what comes next: more features may be added later.

${NO_FACTORY_TRACE}

The kind is always "overview".`;
