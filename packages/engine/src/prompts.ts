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
 *   KB SWEEP PIPELINE (classify → contradict → produce → label):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Contribution (wolf den topic or emitted delta)           │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [CLASSIFY] (fast model, conditional)
 *              │
 *              ├─ CLASSIFY_SYSTEM: route unknown contrib
 *              │  in: contribution text → out: domain/type
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Routed to domain/type/subcategory                        │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *   [CONTRADICT] (fast model, conditional)
 *              │
 *              ├─ CONTRADICT_SYSTEM: compare with existing entry
 *              │  in: new text + existing text + dates → out: winner
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Merge decision (merge_known, create, supersede)          │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *        [PRODUCE] (smart model)
 *              │
 *              ├─ PRODUCE_SYSTEM: write curated entry
 *              │  in: contribution + existing (if merge) → out: entry
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Curated KB entry (entry.md)                              │
 *   └──────────┬───────────────────────────────────────────────┘
 *              │
 *        [LABEL] (fast model, deferrable)
 *              │
 *              ├─ LABEL_SYSTEM: name a topic cluster
 *              │  in: member entry summaries → out: topic label
 *              │
 *              ▼
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Canonical topic (curated cluster label)                  │
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

import { ENTRY_TYPES } from "./schemas/index.js";
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
 * The LLM may NOT invent section ids or emit free text 

 This is an enum-constrained
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
 * stage: section-summary (hierarchy crystallize) · model: fast · in: child summaries (capped) · out: one paragraph
 *
 * Summarize a bounded set of child entry summaries into ONE paragraph describing
 * what the section is about. Summarize-only, no new facts, no structure.
 */
export const SECTION_SUMMARY_SYSTEM = `You summarize a section of the knowledge base.

You will be given a list of entry summaries (the children of one section). Your task: write ONE paragraph that describes what this section is about 

 the common theme that ties these entries together.

Rules:
- Write one paragraph only. No bullets, no structure, no headings.
- Summarize the scope 

 theme. Do NOT restate individual facts from the entries.
- Do NOT add new information. Only synthesize what is present.
- Keep it under 3 sentences.

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
sections, and a few member entry titles. Produce a SHORT, specific title that names
this section's topic AND is distinct from its parent and siblings.

Rules:
- 2 to 6 words. Title Case. No trailing punctuation.
- Name the TOPIC specifically. Do NOT use generic words like "Section" or "Overview".
- If a parent title or sibling sections are given, make THIS title DISTINCT: do not
  repeat the parent's wording wholesale "" name what is specific to this subsection
  versus its siblings.
- Do NOT add new information. Derive the title only from what is given.

Output valid JSON matching the schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB SWEEP: CLASSIFY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: classify (KB sweep) · model: fast · in: contribution + digest sections (enum) · out: section id or NEW
 *
 * Route a contribution to ONE section from the digest, or NEW. This is now a
 * section-pick operation (enum-constrained), replacing the old domain/type/subcategory.
 */
export const CLASSIFY_SYSTEM = `You route a knowledge contribution to exactly ONE section from the knowledge base.

You will be given:
1. A contribution (title + summary + body)
2. A closed list of section ids with their summaries (the enum you must pick from)

Your task: pick the single best-fit section id from the list, or return the literal string "NEW" if none fit well.

Rules:
- You MUST return a section id that was provided in the list, or the exact string "NEW".
- NEVER invent a section id. NEVER return free text, a domain name, or a description.
- If multiple sections could fit, pick the most specific one.
- If no section is a good fit, return "NEW" and the system will create a new section or park it.
- Rate your confidence: low/medium/high.

Output valid JSON matching the schema (section: string, confidence: enum).`;

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

// ═══════════════════════════════════════════════════════════════════════════
// KB SWEEP: PRODUCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: produce (KB sweep) · model: smart · in: contribution + existing (if merge) · out: entry
 *
 * Write a curated KB entry from a contribution, integrating with existing if merging.
 * PRODUCE_SYSTEM is built from the array pattern in produce.ts with ENTRY_TYPES interpolated.
 */
export const PRODUCE_SYSTEM = `You write a single curated knowledge-base entry from a wolf's contribution.
Be precise and sourced. On merge, integrate the new information into the
existing entry, changing only what the contribution affects.

FRONTMATTER RULES (the entry is machine-read — be disciplined):
- type MUST be exactly one of: ${ENTRY_TYPES.join(", ")}.
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
  "sfo1", "provider": "digitalocean", "test-count": "42"}. Use this (not facets)
  for host/provider/region/version/counts/thresholds and similar specifics.
  Keys: short, descriptive. Values: a single string (stringify numbers). Omit
  prose or anything already in the body; leave empty ({}) when nothing fits.
- Do NOT set id, domain, subcategory, created, updated, authority — those are
  owned by the pipeline and will be overwritten.
- In the body, wrap hex color codes and other '#'-prefixed literals in backticks
  (e.g. \`#2E7D32\`) so Obsidian does not misread them as tags.

Output JSON matching the entry schema.`;

// ═══════════════════════════════════════════════════════════════════════════
// KB SWEEP: LABEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * stage: label (KB sweep) · model: fast · in: member entry summaries · out: topic label
 *
 * Name a cluster of related knowledge entries.
 * Deferrable — can be batched or deferred for efficiency.
 */
export const LABEL_SYSTEM = `You name a cluster of related knowledge entries with a concise human topic label and a kebab-case slug. Output JSON only.`;

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
