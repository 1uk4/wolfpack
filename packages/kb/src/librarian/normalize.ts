/**
 * normalize — deterministic frontmatter guardrails. Pure code, NO LLM.
 *
 * Runs after the generative `produce` call and before `commitEntry`. The LLM is
 * the proximate cause of frontmatter drift; this module is the backstop that the
 * model cannot own. It enforces the invariants that keep the KB machine-readable:
 *
 *   - canonical field presence + enum membership (type/status/confidence/authority)
 *   - id ↔ domain agreement (prefix must match the entry's domain)
 *   - link hygiene: related/supersedes are unique, self-free, well-formed ids
 *   - date sanity: created ≤ updated; expires (if any) must be after created
 *   - empty-string optionals collapsed to undefined (renderer omits them)
 *   - tag required + kebab-normalized when type=other
 *
 * Every mutation is recorded as a warning so sweeps stay auditable.
 */
import { ENTRY_TYPES, type Entry, type EntryType } from "@wolfpack/engine";
import type { Entry as EntryV2, SectionId, Relation } from "../schema/knowledge.js";

/** Valid entry id shape: kb-<domain>-<7 alphanumerics>. */
const ID_RE = /^kb-[a-z0-9]+-[0-9A-Za-z]{7}$/;
/** YYYY-MM-DD. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ENTRY_TYPE_SET = new Set<string>(ENTRY_TYPES);

export interface NormalizeResult {
  entry: Entry;
  warnings: string[];
}

function kebab(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyToUndef(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

/**
 * De-dupe, trim, and drop malformed / self-referential ids from a link list.
 * When `knownIds` is supplied, also enforce referential integrity: a link that
 * is shape-valid but points to no existing entry is a dangling link and dropped.
 * (Shape alone is insufficient — an invented slug like `kb-snapjack-leagues`
 * coincidentally matches the 7-char id shape.)
 */
function cleanLinks(
  ids: string[] | undefined,
  selfId: string,
  field: string,
  warnings: string[],
  knownIds?: Set<string>
): string[] {
  if (!ids || ids.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (id === "") continue;
    if (id === selfId) {
      warnings.push(`${field}: dropped self-reference (${id})`);
      continue;
    }
    if (!ID_RE.test(id)) {
      warnings.push(`${field}: dropped malformed id (${id})`);
      continue;
    }
    if (knownIds && !knownIds.has(id)) {
      warnings.push(`${field}: dropped dangling link (${id} \u2014 no such entry)`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`${field}: dropped duplicate (${id})`);
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Normalize a produced entry in place-of-a-copy. Pass the authoritative domain
 * (the sweep already knows it) so we can verify the id prefix agrees.
 */
export function normalizeEntry(
  entry: Entry,
  domain: string,
  knownIds?: Set<string>
): NormalizeResult {
  const warnings: string[] = [];
  const fm = { ...entry.frontmatter };

  // ── type / tag ──────────────────────────────────────────────────────────
  if (!ENTRY_TYPE_SET.has(fm.type)) {
    warnings.push(`type: '${fm.type}' not in vocabulary → 'other' (tag preserved)`);
    fm.tag = fm.tag && fm.tag.trim() !== "" ? kebab(fm.tag) : kebab(String(fm.type));
    fm.type = "other" as EntryType;
  }
  fm.tag = emptyToUndef(fm.tag);
  if (fm.tag) fm.tag = kebab(fm.tag);
  if (fm.type === "other" && !fm.tag) {
    warnings.push("type=other with no tag → tag defaulted to 'uncategorized'");
    fm.tag = "uncategorized";
  }

  // ── domain / id agreement ─────────────────────────────────────────────────
  fm.domain = domain;
  if (!fm.id || !fm.id.startsWith(`kb-${domain}-`)) {
    warnings.push(
      `id '${fm.id}' does not match domain '${domain}' (prefix mismatch — integrity risk)`
    );
  }

  // ── subcategory ───────────────────────────────────────────────────────────
  fm.subcategory = emptyToUndef(fm.subcategory);
  if (fm.subcategory) fm.subcategory = kebab(fm.subcategory);

  // ── link hygiene ──────────────────────────────────────────────────────────
  fm.related = cleanLinks(fm.related, fm.id, "related", warnings, knownIds);
  fm.supersedes = cleanLinks(fm.supersedes, fm.id, "supersedes", warnings, knownIds);

  // ── sources: trim + dedupe (free-form, no id shape) ───────────────────────
  if (Array.isArray(fm.sources)) {
    const seen = new Set<string>();
    fm.sources = fm.sources
      .map((s) => String(s).trim())
      .filter((s) => s !== "" && !seen.has(s) && seen.add(s));
  } else {
    fm.sources = [];
  }

  // ── dates ─────────────────────────────────────────────────────────────────
  if (!DATE_RE.test(fm.created)) warnings.push(`created '${fm.created}' is not YYYY-MM-DD`);
  if (!DATE_RE.test(fm.updated)) warnings.push(`updated '${fm.updated}' is not YYYY-MM-DD`);
  if (DATE_RE.test(fm.created) && DATE_RE.test(fm.updated) && fm.updated < fm.created) {
    warnings.push(`updated (${fm.updated}) < created (${fm.created}) → updated set to created`);
    fm.updated = fm.created;
  }
  const expires = emptyToUndef(fm.expires);
  if (expires) {
    if (!DATE_RE.test(expires)) {
      warnings.push(`expires '${expires}' is not YYYY-MM-DD → dropped`);
      fm.expires = undefined;
    } else if (DATE_RE.test(fm.created) && expires <= fm.created) {
      warnings.push(`expires (${expires}) ≤ created (${fm.created}) → dropped (invalid)`);
      fm.expires = undefined;
    } else {
      fm.expires = expires;
    }
  } else {
    fm.expires = undefined;
  }
  fm.asOf = emptyToUndef(fm.asOf);

  return { entry: { ...entry, frontmatter: fm }, warnings };
}


// ============================================================================
// V2 PATH — validate section + relations referential integrity
// ============================================================================

export interface NormalizeV2Result {
  entry: EntryV2;
  warnings: string[];
}

/**
 * V2: Normalize a produced v2 entry. Validates section id is known,
 * drops relations whose targets don't exist (referential integrity firewall).
 */
export function normalizeEntryV2(
  entry: EntryV2,
  knownSections: Set<string>,
  knownEntries: Set<string>
): NormalizeV2Result {
  const warnings: string[] = [];

  // Validate section exists
  if (!knownSections.has(entry.section)) {
    warnings.push(`section: ${entry.section} not in known sections (orphaned entry)`);
  }

  // Drop relations with unknown targets (referential integrity)
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
