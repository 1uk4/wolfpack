/**
 * vocab.ts — CONTROLLED VOCABULARIES (editable configuration).
 *
 * This is the categorization control surface. Every closed set the LLM must pick
 * from, and every structural enum the code relies on, lives here — in ONE place —
 * so you can grow or reshape the taxonomy as you learn what works, without
 * hunting through the codebase. Pair this with `prompts.ts` (how the LLM is told
 * to choose) and `tuning.ts` (the numeric knobs).
 *
 * Principle (typesafe.ai): these are the *contract*. The LLM may only ever emit
 * values from these sets; code validates on the way in. Grow them deliberately.
 */
import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════════
// ENTRY KIND — document kind for LIBRARY (reference) nodes
// `other` is handled by a discriminated union (requires a staging `tag`), so it
// is intentionally NOT in this list. Add recurring tags here to promote them.
// ════════════════════════════════════════════════════════════════════════════
export const ENTRY_KINDS = [
  "architecture",
  "reference",
  "overview",
  "api",
  "changelog",
  "decision",
  "process",
  "fact",
  "policy",
  "product",
  "incident",
] as const;

// ════════════════════════════════════════════════════════════════════════════
// WORK KIND — the shape of a FACTORY (work) node
// Flexible on purpose: add kinds as the factory's needs become clear.
// ════════════════════════════════════════════════════════════════════════════
export const WORK_KINDS = [
  "idea", // raw proposal
  "initiative", // a larger body of work / epic
  "feature", // a shippable capability
  "task", // a unit of execution
  "issue", // a defect / problem to resolve
  "spike", // time-boxed investigation
] as const;
export const WorkKind = z.enum(WORK_KINDS);
export type WorkKind = z.infer<typeof WorkKind>;

// ════════════════════════════════════════════════════════════════════════════
// STAGE — the business pipeline for FACTORY nodes (IDEAS → … → LIVE)
// The ORDERED list is the default pipeline; legal transitions live in
// factory config (so different projects can diverge). Editable here.
// ════════════════════════════════════════════════════════════════════════════
export const STAGES = [
  "idea",
  "plan",
  "feasibility",
  "approved",
  "in_build",
  "shipped",
  "live",
  "archived",
] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

// ════════════════════════════════════════════════════════════════════════════
// RELATION KIND — typed edges (the two-layer link model)
//   see_also/similar : associative web  (embedding-derived, deterministic)
//   part_of/refines  : formal backbone  (hierarchy)
//   references       : WORK → LIBRARY (a task pulls its context)
//   graduated_from   : LIBRARY ← WORK (shipped work distilled into an Entry)
//   blocks/depends_on/supersedes/contradicts : semantic / workflow
// ════════════════════════════════════════════════════════════════════════════
export const RELATION_KINDS = [
  "see_also",
  "refines",
  "part_of",
  "depends_on",
  "supersedes",
  "contradicts",
  "references", // work → context
  "graduated_from", // entry ← work
  "blocks", // work → work
] as const;

/** Controlled facet keys (replace free-text subcategory). Values are Slugs. */
export const FACET_KEYS = ["subsystem", "surface", "layer", "lifecycle"] as const;
