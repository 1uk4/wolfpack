/**
 * Central LLM system prompts registry — consolidates all system prompts
 * used throughout the wolfpack pipeline.
 *
 * DATAFLOW OVERVIEW:
 *
 *   LIVE MEMORY PIPELINE (observe → consolidate → journey):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Agent conversation                                       │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *        [OBSERVER] (fast model)
 *              │
 *              ├─ OBSERVER_SYSTEM: classify raw conversation
 *              │  in: conversation chunk → out: observations
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Observation pool (ledger)                                │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [CONSOLIDATE] (smart model, when the pool overflows)
 *   orchestrator.ts + SESSION_CONSOLIDATION_USER_PROMPT
 *              │
 *              ├─ CONSOLIDATE_SYSTEM: fold observations into
 *              │  session topics
 *              │  in: observations + session topics → out: topics
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Session topics (.memory/<sid>/topics/)                   │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   (Session end → promotion: deterministic upsert into the den,
 *    no LLM; merging across sessions is owned by the KB sweep)
 *              │
 *        [JOURNEY] (appended, simple v1)
 *   buildJourneyPrompt: not yet wired to LLM
 *              │
 *              ├─ JOURNEY_SYSTEM: reserved for future LLM call
 *              │  in: session summary + journey → out: updated journey
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Den topics + den journey (wolf persistent memory)        │
 *   └──────────────────────────────────────────────────────────┘
 *
 *
 *   KB SWEEP PIPELINE (route → contradict → produce; reorg maintains sections):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Contribution (wolf den topic or emitted delta)           │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [ROUTE] (embeddings; fast model only when ambiguous)
 *              │
 *              ├─ SECTION_PICK_SYSTEM: pick ONE section id or NEW
 *              │  in: contribution + digest sections (enum) → out: section
 *              │
 *              ▼
 *   [CONTRADICT] (fast model, conditional)
 *              │
 *              ├─ CONTRADICT_SYSTEM: compare with existing entry
 *              │  in: new text + existing text + dates → out: winner
 *              │
 *              ▼
 *        [PRODUCE] (smart model)
 *              │
 *              ├─ PRODUCE_SYSTEM: write curated entry
 *              │  in: contribution + existing (if merge) → out: entry
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Curated KB entry, placed in the section tree             │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [REORG] (fast model; `wolfpack-kb reorg`)
 *              │
 *              ├─ SECTION_SUMMARY_SYSTEM: one-line section summary
 *              ├─ LABEL_SECTION_SYSTEM: short section title
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ _digest.json + INDEX.md per domain                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 *
 *   CRAWL PIPELINE (extract → consolidate → journey):
 *   (Mirrors live memory but on documents; see docs/crawl-spec.md)
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Historical source documents (files, directories)         │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *        [OBSERVER] (fast model, document mode)
 *              │
 *              ├─ CRAWL_OBSERVER_SYSTEM: extract from documents
 *              │  in: document chunk + source date → out: observations
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Dated observations (per-batch, in time order)            │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [CONSOLIDATE] (smart model)
 *   buildCrawlConsolidatePrompt (template: packages/memory/src/config/prompts)
 *              │
 *              ├─ CRAWL_CONSOLIDATE_SYSTEM: fold into crawl topics
 *              │  in: observations (one topic) → out: current-state topic
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Crawl topics: current state + dated events               │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [JOURNEY] (smart model, rolling chunks)
 *   buildJourneyPrompt (template: packages/memory/src/config/prompts)
 *              │
 *              ├─ CRAWL_JOURNEY_SYSTEM: build domain history
 *              │  in: current journey + dated events (chunk) →
 *              │  out: extended journey
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Crawl journey: chronological narrative                   │
 *   └──────────────────────────────────────────────────────────┘
 */

import { ENTRY_KINDS } from "./config/vocab.js";
export {
  OBSERVER_SYSTEM,
  CONSOLIDATE_SYSTEM,
  JOURNEY_SYSTEM,
  CRAWL_OBSERVER_SYSTEM,
  CRAWL_CONSOLIDATE_SYSTEM,
  CRAWL_JOURNEY_SYSTEM,
} from "./config/prompts/memory.js";


// ═══════════════════════════════════════════════════════════════════════════
// LIVE MEMORY: OBSERVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: observer (live) · model: fast · in: conversation chunk · out: observations
 *
 * Extract timestamped observations from a conversation chunk.
 * Each observation is an atomic event or state change.
 */
// OBSERVER_SYSTEM is exported from ./config/prompts/memory.js.

// ═══════════════════════════════════════════════════════════════════════════
// LIVE MEMORY: CONSOLIDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: consolidate (live) · model: smart · in: observations + session topics · out: topics
 *
 * Fold overflowing observations into session topics (merge/create/skip).
 * Called from packages/memory/src/orchestrator.ts; user prompt template is
 * SESSION_CONSOLIDATION_USER_PROMPT in packages/memory/src/config/prompts.
 */
// CONSOLIDATE_SYSTEM is exported from ./config/prompts/memory.js.

// ═══════════════════════════════════════════════════════════════════════════
// LIVE MEMORY: JOURNEY (reserved for future LLM use)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: journey (live, reserved) · model: smart · in: session summary + journey · out: updated journey
 *
 * Update the wolf's running project history.
 * NOTE: Currently implemented as simple append (packages/memory/src/consolidate.ts updateJourney).
 * This prompt is reserved for future LLM-based implementation.
 * Dynamic builder: buildJourneyPrompt (in packages/memory/src/prompts.ts; template in packages/memory/src/config/prompts).
 */
// JOURNEY_SYSTEM is exported from ./config/prompts/memory.js.

// ═══════════════════════════════════════════════════════════════════════════
// KB HIERARCHY: SECTION PICK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: section-pick (KB sweep route) · model: fast · in: contribution + digest sections (enum) · out: section id or NEW
 *
 * Choose exactly ONE section id from the provided list, or the literal string "NEW".
 * The LLM may NOT invent section ids or emit free text — this is an enum-constrained
 * routing decision only.
 */
export const SECTION_PICK_SYSTEM = `You route a knowledge contribution to exactly ONE section.

You will be given:
1. A contribution (title + summary)
2. A closed list of section ids with their summaries (the enum you must pick from)

Your task: pick the single best-fit section id from the list, or return the literal string "NEW" if none fit well.

Rules:
- You MUST return a section id that was provided in the list, or the exact string "NEW".
- NEVER invent a section id. NEVER return free text or a description.
- If multiple sections could fit, pick the most specific one.
- If no section is a good fit (cosine would be weak), return "NEW".
- Rate your confidence: low/medium/high.

Output valid JSON matching the schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB HIERARCHY: SECTION SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: section-summary (kb reorg) · model: fast · in: member titles + summaries (capped) · out: one line ≤140 chars
 *
 * One specific line naming what a section's entries are about. It is the
 * summary shown in _digest.json and wolves' <kb_access>, so it must be short.
 * Summarize-only, no new facts, no structure.
 */
export const SECTION_SUMMARY_SYSTEM = `You write the one-line summary for a section of the knowledge base.

You will be given the entries filed in one section: each entry's title, and its
summary when available. Write ONE sentence (at most 140 characters) that names
what these entries are about, so a reader scanning an index can tell at a glance
whether this section is relevant.

Rules:
- Name the subject directly. Do NOT open with "This section", "This collection",
  "Covers", "Documentation of", or any other framing about the section itself.
- Be specific: use the concrete systems, products, and terms the entries share
  (e.g. "Glicko-2 player ratings, leaderboards, and season stats").
- Synthesize the shared scope. Do NOT list every entry or restate their facts.
- Do NOT add information that is not in the entries.
- Plain text: no markdown, no headings, no bullets.

Output valid JSON matching the schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB HIERARCHY: LABEL SECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: label-section (hierarchy / backfill) · model: fast · in: section summary + sample titles · out: short title
 *
 * Name a section with a SHORT human title from its summary. Labeling only — no
 * new facts, no ids. Replaces placeholder titles like "(split 1)".
 */
export const LABEL_SECTION_SYSTEM = `You name a section of the knowledge base with a short title.

You will be given a section summary, and optionally its parent title, its sibling
sections, the domain name, and a few member entry titles. Produce a SHORT, specific
title that names this section's topic AND is distinct from its parent and siblings.

Rules:
- 2 to 6 words. Title Case. No trailing punctuation.
- Name the TOPIC specifically. Do NOT use generic words like "Section" or "Overview".
- NEVER prefix the title with the domain name. The domain is already implicit in
  the tree — "Acme Platform Authentication" should just be "Platform Authentication".
  Member entry titles often include the domain for provenance; strip it from your output.
- If a parent title or sibling sections are given, make THIS title DISTINCT: do not
  repeat the parent's wording wholesale — name what is specific to this subsection
  versus its siblings.
- Do NOT add new information. Derive the title only from what is given.
- Use ONLY terms that appear in the entries. Never infer or add qualifiers
  (e.g. "AI", "ML", "intelligent", "automated") that the entries do not use.

Output valid JSON matching the schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB SWEEP: CONTRADICT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: contradict (KB sweep) · model: fast · in: new text + existing text + dates · out: winner
 *
 * Compare a contribution against an existing entry to detect contradictions
 * and determine which should take precedence.
 */
export const CONTRADICT_SYSTEM = `You compare a NEW knowledge contribution against an EXISTING KB entry. Decide only whether they factually conflict, and if so which should win. Base 'winner' on recency and specificity of evidence, using the supplied dates. IMPORTANT: if the NEW contribution is marked currency=archived and its date is older than the existing entry, prefer 'existing' and treat the new material as historical context, NOT a correction. Also: origin=crawl means the NEW material was bulk-ingested from old documents (a wolf acting as a scribe), not lived/curated knowledge — do not let it overwrite a current entry unless it is clearly more recent AND more specific. Output JSON only.`;

/**
 * stage: matchSubject (KB sweep) · model: fast · in: contribution title+summary + up to 3 candidate entries · out: entry id | "new"
 *
 * Subject check for an uncertain embedding match: is the contribution about the
 * same subject as one of the nearest entries?
 */
export const MATCH_SUBJECT_SYSTEM = `You decide whether a new knowledge contribution is about the SAME SUBJECT as one of a few existing KB entries.

Merge only if the contribution is an update, correction or extension of that entry's own subject (the same system, feature, decision or incident). Entries that are merely related, adjacent, or in the same area are NOT the same subject: a fix to the sweep is not part of an entry about the memory timer; a feature that uses a system is not part of that system's entry.

Answer with the id of the one entry that is the same subject, or "new" if none is. When unsure, answer "new".
Output JSON only: {"match": "<entry id or new>", "reason": "<one short sentence>"}.`;

/**
 * stage: confirmSubject (KB sweep) · model: fast · in: the contribution's full body + the near-miss candidate's full body · out: merge | different
 *
 * Second look before a near-miss CREATE: the title+summary check said "new" but
 * the nearest entry scored high. With both full texts, is it the same subject?
 */
export const CONFIRM_SUBJECT_SYSTEM = `You are given a new knowledge contribution and ONE existing KB entry that scored as very similar. Decide from the full texts whether the contribution is about the SAME SUBJECT as the entry.

Answer "merge" if the contribution is an update, correction, extension or a part of that entry's own subject (the same system, feature, decision, incident or initiative), so that a reader looking for this subject would expect to find it in that entry. Answer "different" if it is a separate subject that merely shares vocabulary, an adjacent feature, or a user of that system.

Output JSON only: {"verdict": "merge" | "different", "reason": "<one short sentence>"}.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB SWEEP: PRODUCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: distill (promote) · model: smart · in: one den topic (+ previous slugs) · out: 1-4 KB contributions
 *
 * A den topic is private working memory: it may carry status, task ids, commit
 * hashes, test counts and "deployed/verified" notes. Promote converts it into
 * contributions that read as durable knowledge before anything reaches the KB.
 */
export const DISTILL_SYSTEM = `You convert ONE wolf's private working-memory topic into contribution(s) for a shared, curated knowledge base.

The topic is a working note. It may mix durable knowledge with progress noise: status, task ids, commit hashes, test counts, "deployed" / "verified" lines, session narrative. The knowledge base keeps only what stays true and useful: what the subject is, how it works, what was decided and why. Convert, do not just delete.

For each contribution write:
- slug: short lower-kebab name of its subject.
- title: the subject, as a noun phrase (no dates, no "deployed", no status).
- summary: ONE paragraph that stands alone as the lede: what the subject is and its key facts. The body must not repeat it.
- body: markdown starting at its first "## " section (no "# " title line, no lede). Describe the CURRENT state in present-tense prose, with the lasting detail: file paths, identifiers, names, error codes, numbers that are part of the design (limits, intervals, thresholds). Aim for at most about 4,000 characters, never more than 5,000, excluding History.

CONVERT, DO NOT LOG:
- When the topic records that a fact CHANGED (it says what was before and what is now, or when it was changed), write the new fact in the body and add one line to a final "## History" section:
  - Until <YYYY-MM-DD>: <old fact>. Now <new fact>, because <why, if the topic says>.
  Use the date the topic gives for the change; if it gives none, use the TOPIC DATE. Each line at most two sentences, dated, with a reason only when known. A line keeps the dated substance (what the old fact was, when, why it changed), never a vague "updated". When History would pass about 15 lines, fold the oldest lines into one summary line saying the full earlier text is in versions/, for example "- Earlier history (before <YYYY-MM-DD>): <summary>; see versions/ for prior text." Omit the section when nothing changed.
- LEAVE OUT, entirely: commit hashes, task ids, work ids (except the closing citation of a graduation History line, see GRADUATION INPUT), "N tests pass" lines, "deployed" / "verified" / "shipped" status, "unverified live" notes, who did what in which session, next-step lists, what is pending. These stay in the wolf's private notes.
- Never put a date in a heading or in the body outside History. Never put a hash or id in History (the graduation citation excepted).
- Do not add facts the topic does not state.

ONE SUBJECT EACH. If the topic covers clearly different subjects (for example a design AND a separate incident, or two unrelated systems), return one contribution per subject, at most 4, the main subject first. Otherwise return exactly one. Do not split a single subject into parts.

PREVIOUS CONTRIBUTIONS may be listed (slug: title) from earlier promotes of this topic. Reuse the slug of a subject that is already there so it keeps its identity; invent a new slug only for a new subject.

EXISTING ENTRIES may be listed (id: title — summary): the entries the knowledge base already holds that are nearest to this input. When a contribution is about the SAME SUBJECT as one of them (an update, correction or extension of that entry's own subject), use that entry's title EXACTLY as the contribution's title and add "target": "<that entry id>". Do not invent a new title for a subject that already has an entry. A contribution about a subject none of them covers gets its own title and no target. Never target an entry that is merely related or adjacent.

If CHECK FAILURES are listed, your previous answer broke those rules: rewrite the contributions and fix every one.

Respond with valid JSON: {"contributions": [{"slug", "title", "summary", "body", "target"?}]}.`;

/**
 * stage: distill (graduation) · appended to DISTILL_SYSTEM when the input is a finished work item
 *
 * Graduation is NOT a separate pipeline: the item's plan, Record, Outcomes and
 * tasks are distilled like any topic, into subject contributions that flow
 * through the inbox and the sweep's subject check. This only reframes the input.
 */
export const DISTILL_GRADUATION = `GRADUATION INPUT. When the input is headed "GRADUATION OF", it is not a private note but the record of a FINISHED work item: its plan, its Record (decisions, changes, findings, problems), its Outcomes, its tasks, and the initiative it belongs to. Convert it the same way, with these differences:
- Write for the SUBJECTS the work affected (a system, a process, a rule), never for the work item itself. One contribution per affected subject, at most 4, main subject first, each describing how that subject works NOW as the Record and Outcomes establish it. The plan is intent written before the work and may be outdated: the Record and the Outcomes win. Do not write a past-tense "feature entry"; no task lists, no remaining work.
- A decision in the Record with lasting weight (what was chosen, what was rejected, why) gets its OWN contribution when it stands apart from any one subject: title = the decision as a noun phrase, body = the decision, the reasons, the alternatives rejected. Otherwise fold it into the subject it shaped.
- HISTORY: every contribution ends with a "## History" section holding at least one line for this work, ending with the WORK ID given in the input, in parentheses, exactly as written:
  - <YYYY-MM-DD>: <what this work changed or decided about the subject, and why> (<work id>)
  or, when a fact was replaced: "- Until <YYYY-MM-DD>: <old>. Now <new>, because <why> (<work id>)". The work id appears ONLY at the end of a History line: never in a title, summary or body section, and never any other work id.
- TOTALS: when the input lists TOTALS, every value (digits and unit) must appear unchanged in the contribution that reports the outcomes, in its body or History.
- INITIATIVE: when the input has an INITIATIVE section, add exactly one more contribution about the initiative, with "initiative": true and slug "initiative". Its body is present tense: the initiative's goal and scope, the decisions that span its features, and what this work delivered, as part of the current state. Link to subject entries with [[kb-...]] ONLY for ids listed under KNOWN ENTRIES; with none listed, describe the subjects in words. When the INITIATIVE section says THIS ITEM, the graduating item is the initiative itself: write ONLY the initiative contribution. If the INITIATIVE is marked COMPLETE, say in the body that it is complete and what it achieved overall. A standing initiative never completes: its entry is a live page of the area. Its History line says what this work added, with the same work id. Every other contribution omits "initiative".
Respond with the same JSON, where a contribution may carry "initiative": true.`;

/**
 * stage: distill (graduation of a feature of a STANDING initiative) · appended after DISTILL_GRADUATION
 *
 * A feature of a standing initiative is one instance of a recurring or
 * open-ended area (one period, one round). It keeps its own entry, which code
 * writes from the feature's own content; the model contributes only a summary
 * of it plus whatever lasting knowledge the work established.
 */
export const DISTILL_GRADUATION_STANDING = `STANDING FEATURE. When the input says its feature belongs to a STANDING initiative, the feature itself is kept as its own entry, written by code from the work item's own content. So, in addition to the rules above:
- Add exactly one contribution with "feature": true and slug "feature". Only its summary is used: ONE paragraph in plain words on what this period or instance of the work was and its outcomes (what was done, what resulted). Keep figures from the input as they are written. Give it a short body (a sentence is enough); it is not stored. Do not put a History section, ids or hashes in it.
- Also write the INITIATIVE contribution as above: the standing initiative's current state, which this work may have changed.
- Write subject contributions ONLY for lasting decisions and findings that the RECORD establishes and that outlive this instance (how something works now, what was decided and why). Do not describe the instance itself in them. Writing none is correct when the Record holds nothing of that kind.
- Every other contribution omits "feature".`;

/**
 * stage: workRecord · model: smart · in: a work item's current Record + its title/criteria/plan + new observations · out: the rewritten Record
 *
 * The Record is the curated knowledge of ONE work item, kept inside the item
 * while it is worked on. Graduation (distill) later turns it into a KB entry.
 */
export const WORK_RECORD_SYSTEM = `You maintain the RECORD of ONE work item: the curated knowledge produced while working on it. The item may be a feature: then the observations come from several of its tasks and subagents, and the Record covers the feature as a whole. You are given the item (title, done-when, plan), its CURRENT RECORD (may be empty) and NEW OBSERVATIONS from the working sessions. Return the complete rewritten Record.

The Record is NOT a log. It is what a colleague needs to understand this work later, in four fixed groups:
- decisions: what was decided AND why (the reason is required; a decision without a reason is not worth keeping). Say what was rejected only when that is the point.
- changes: what is now different (files, modules, behaviours, interfaces, config), in present tense.
- findings: facts learned about the system, the data or the problem that stay true.
- problems: a problem hit and how it was fixed or worked around, as one item (problem, then fix). Include an open problem only when it is still unresolved.

REWRITE, DO NOT APPEND:
- Start from the CURRENT RECORD and fold the new observations in. When an observation changes or reverses a decision, REPLACE the old decision with the new one (say "was X, now Y because Z" in that single item only if the change itself matters). Never keep both versions.
- Merge items about the same subject. Drop items the new observations show to be wrong or obsolete. Fold older detail into shorter lines to stay within about 3,500 characters in total.
- Short bullets, at most two sentences each. Concrete names (paths, identifiers, error codes, numbers that are part of the design) stay.

LEAVE OUT: session narrative ("we then", "the user asked"), test counts and "N tests pass", build/deploy/verified status, who did what, next-step lists, dates (except where a decision's timing is what matters), and anything the plan already says. A commit hash may be kept sparingly, only on a change that is hard to find otherwise.
Do not invent facts that neither the current record nor the observations state. If nothing in the new observations is worth recording, return the current record unchanged.

SOURCES: the CURRENT RECORD lines are numbered [r1], [r2]… and the NEW OBSERVATIONS [o1], [o2]…. For every item, list in "from" the observations it rests on and, when you keep or fold an existing line, that line: e.g. ["o2", "r3"]. An unchanged line keeps its own ref. Use only refs you were given; never put a ref in the text itself.

Respond with valid JSON: {"decisions": [{"decision": string, "why": string, "from": [string]}], "changes": [{"text": string, "from": [string]}], "findings": [{"text": string, "from": [string]}], "problems": [{"text": string, "from": [string]}]}. An empty group is an empty array.`;

/**
 * stage: produce (KB sweep) · model: smart · in: contribution + existing (if merge) · out: entry
 *
 * Write a curated KB entry from a contribution, integrating with existing if merging.
 * Entry types are ENTRY_KINDS from config/vocab.ts plus "other" (which requires a `tag`).
 */
export const PRODUCE_SYSTEM = `You write a single curated knowledge-base entry from a wolf's contribution.
Be precise and sourced. On merge, integrate the new information into the
existing entry, changing only what the contribution affects.

WRITING RULES:
- The body describes the CURRENT state of the subject, in present-tense prose.
  No session narrative, no logs, no commit hashes, no "today we…" or "we
  then…". Dates appear only in the History section (below), never in the body
  (unless the entry type is changelog).
- On merge, REPLACE any fact the contribution supersedes in the body; never
  keep the old and the new side by side. Keep what the contribution does not
  touch.
- HISTORY: end the detail with a final "## History" section. For each fact you
  replaced, add one line:
  - Until <YYYY-MM-DD>: <old fact>. Now <new fact>, because <reason, if known>.
  Use the CONTRIBUTION DATE given in the prompt for <YYYY-MM-DD>; omit the
  "because" clause when the reason is not known. Keep each line to at most two
  sentences. Keep every existing History line exactly as written (never rewrite
  them) and do not add a line for a change already recorded. History lines
  carry dates and reasons only: never a commit hash or task id. A work id
  (work-<domain>-<id>) may appear in a History line ONLY as its closing
  "(work-<domain>-<id>)" citation: when the CONTRIBUTION has History lines with
  such a citation, add them to the entry's History exactly as written, citation
  included. A History line for a replaced fact keeps the
  dated substance (what it was, when, why it changed), never a vague "updated".
  When History would pass about 15 lines, fold the oldest lines into one
  summary line that says the full earlier text is in versions/, for example
  "- Earlier history (before <YYYY-MM-DD>): <summary>; see versions/ for prior text."
  Omit the section when there is nothing to record. Do not put a History section
  anywhere but last, and do not use the \`context\` field for it.
- DECISION entries: when the EXISTING ENTRY has kind "decision", never change
  its body. If the contribution contradicts or changes the decision, set
  "supersedesDecision": true and write the NEW decision as a complete entry of
  kind "decision" (the pipeline keeps the old one and links the new one to it).
  Otherwise leave "supersedesDecision" false; your output is then discarded and
  the decision stays as it is.
- LAYOUT: the entry is rendered as "# <title>", then the summary as the lede,
  then the detail. The summary is the whole lede (one paragraph, however many
  sentences it needs). Start the detail at its first "## " section: do NOT
  repeat the title as a "# " heading, do NOT repeat the summary at its top.
- Never write commit hashes, task ids, "N tests pass" lines, or
  "deployed"/"verified" status lines anywhere in the entry, and never repeat
  the summary in the detail. A work id appears only as a History line's closing
  citation, never in the title, summary, body or properties. Leave out progress notes; keep only what is true
  of the subject.
- Stay on the entry's subject: the one the CONTRIBUTION belongs to. If the
  contribution contains material about a different subject, leave it out. When
  the prompt says "OVERFLOW: allowed", put a second subject in \`overflow\` as
  {"title", "summary", "detail"} instead: a different system, feature or
  incident from the one the entry's title names, whether it came with the
  contribution or is ALREADY in the existing entry. Write it as its own
  complete entry under these same rules, and remove it from this entry: it must
  not appear in this entry's title, summary or detail. Return no \`overflow\`
  when everything is one subject.
- No repetition on merge: add only what the EXISTING ENTRY does not already say,
  in its body or its History. A fact already there stays as it is, in its place,
  and is never restated in another sentence, bullet or section; never write the
  same section twice.
- Link only with [[<entry id>]] where the id is a real kb-<domain>-<id> id given
  to you in the prompt or the existing entry. Never write a placeholder or an
  invented id in [[ ]]: name the subject in plain words instead.
- Be concise: aim for at most ~6,000 characters in the body; the History
  section does not count towards that. Cut redundancy and detail that does not
  help someone using the subject.

FRONTMATTER RULES (the entry is machine-read — be disciplined):
- type MUST be exactly one of: ${[...ENTRY_KINDS, "other"].join(", ")}.
  Return it as an object, e.g. "kind": {"type": "architecture"} (for 'other':
  "kind": {"type": "other", "tag": "migration-guide"}), never a bare string.
  Pick the single best fit. Prefer a precise type over a generic one
  (e.g. an API surface is 'api', a timeline/changelog is 'changelog',
  a settled choice is 'decision', a runbook is 'process', terms/privacy is
  'policy', marketing/community/ASO is 'product', a bug/outage is 'incident').
- If and ONLY if none fit, set type='other' and put your preferred
  kebab-case word in \`tag\` (e.g. tag: migration-guide). Leave \`tag\` empty
  otherwise unless it genuinely refines the type.
- related/supersedes: use ONLY real entry ids of the form kb-<domain>-<id>.
  Never invent slugs, never reference this entry itself. If unsure, leave empty.
- facets: an OPTIONAL controlled classification map. The ONLY allowed keys are:
  subsystem, surface, layer, lifecycle. Each value is ONE lower-kebab slug
  (e.g. {"subsystem": "auth", "lifecycle": "archived"}). Facets CLASSIFY the
  entry on these four axes — they are NOT for capturing arbitrary properties.
  Omit any axis you are unsure about; leave facets empty ({}) when none apply.
- properties: an OPTIONAL open map for concrete structured ATTRIBUTES the source
  carries that are NOT classification axes — e.g. {"host": "sfo01", "region":
  "sfo1", "provider": "digitalocean", "retries": "3"}. Use this (not facets)
  for host/provider/region/version/counts/thresholds and similar specifics.
  Keys: short, descriptive. Values: a single string (stringify numbers).
  Never use keys like commit, commits, test-count, tests, task, work-id or
  scores: progress noise is not knowledge. Omit
  prose or anything already in the body; leave empty ({}) when nothing fits.
- Do NOT set id, domain, subcategory, created, updated, authority — those are
  owned by the pipeline and will be overwritten.
- In the body, wrap hex color codes and other '#'-prefixed literals in backticks
  (e.g. \`#2E7D32\`) so Obsidian does not misread them as tags.

Output JSON matching the entry schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL: OBSERVER (document mode)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: observer (crawl/document) · model: fast · in: document chunk + source date · out: observations
 *
 * Extract timestamped observations from historical documents.
 * Same precision bar as OBSERVER_SYSTEM, adapted for document mode where timestamps
 * are recovered dates rather than message timestamps.
 */
// CRAWL_OBSERVER_SYSTEM is exported from ./config/prompts/memory.js.

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL: CONSOLIDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: consolidate (crawl) · model: smart · in: observations (one topic) · out: current-state topic
 *
 * Fold dated observations from historical documents into one current-state topic entry.
 * Produces title, summary, body, and dated events (the raw material for the domain journey).
 * Dynamic builder: buildCrawlConsolidatePrompt (in packages/memory/src/crawl/consolidate.ts; template in packages/memory/src/config/prompts).
 */
// CRAWL_CONSOLIDATE_SYSTEM is exported from ./config/prompts/memory.js.

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL: JOURNEY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: journey (crawl) · model: smart · in: current journey + dated events (chunk) · out: extended journey
 *
 * Build/extend a domain's chronological narrative from dated events.
 * Events are fed in chunks; the journey is rolled forward incrementally.
 * Dynamic builder: buildJourneyPrompt (in packages/memory/src/crawl/journey.ts; template in packages/memory/src/config/prompts).
 */
// CRAWL_JOURNEY_SYSTEM is exported from ./config/prompts/memory.js.
