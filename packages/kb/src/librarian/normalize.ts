/**
 * normalize — deterministic referential-integrity guardrails for a produced
 * entry. Pure code, NO LLM.
 *
 * Runs after the generative `produce` call and before `commitEntry`. The LLM is
 * the proximate cause of structural drift; this module is the backstop the model
 * cannot own. It validates that the entry's section id is known and drops any
 * relation whose target does not exist (the referential-integrity firewall), so
 * no invented or dangling link ever reaches disk. Every mutation is recorded as
 * a warning so sweeps stay auditable.
 */
import type { Entry, Relation } from "../schema/knowledge.js";

export interface NormalizeResult {
  entry: Entry;
  warnings: string[];
}

/**
 * Normalize a produced entry: validate its section is known and drop relations
 * whose targets don't exist (or point at itself). Returns a copy plus warnings.
 */
export function normalizeEntry(
  entry: Entry,
  knownSections: Set<string>,
  knownEntries: Set<string>
): NormalizeResult {
  const warnings: string[] = [];

  // Validate section exists
  if (!knownSections.has(entry.section)) {
    warnings.push(`section: ${entry.section} not in known sections (orphaned entry)`);
  }

  // Drop relations with unknown or self targets (referential integrity)
  const validRelations: Relation[] = [];
  for (const rel of entry.relations) {
    if (rel.target === entry.id) {
      warnings.push(`relation: dropped self-reference (${rel.kind} → ${rel.target})`);
      continue;
    }
    if (!knownEntries.has(rel.target)) {
      warnings.push(`relation: dropped dangling ${rel.kind} → ${rel.target} (no such entry)`);
      continue;
    }
    validRelations.push(rel);
  }

  return {
    entry: { ...entry, relations: validRelations },
    warnings,
  };
}
