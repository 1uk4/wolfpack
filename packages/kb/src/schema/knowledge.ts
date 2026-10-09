/**
 * knowledge.ts — the TYPED CONTRACT for a knowledge-base entry.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PHILOSOPHY  (after https://typesafe.ai/manifesto)
 * ──────────────────────────────────────────────────────────────────────────
 * 1. Make illegal states unrepresentable. The type system — not a prompt, not a
 *    convention — is the single source of truth for an entry's shape. If the
 *    compiler accepts it, it is a structurally valid entry.
 * 2. The LLM is an *opinion function*, nothing more. It has a typed input and a
 *    narrow, strongly-typed output (`LlmOpinion`). It never emits an `Entry`.
 * 3. Determinism at the core, nondeterminism at the edges. Everything that CAN
 *    be computed by code (ids, dates, hashes, embeddings, clusters, centrality,
 *    link resolution, validation) IS computed by code (`DerivedFacts`). The
 *    opinion is the only probabilistic input, and it is validated on the way in.
 * 4. The final `Entry` is ASSEMBLED by a pure function from three sources whose
 *    authorities never overlap:  opinion ⊕ derived ⊕ curator → Entry.
 *
 *          ┌────────────┐   narrow, enum-constrained
 *   corpus │    LLM     │──────────────┐
 *   ──────▶│ (opinion)  │  LlmOpinion  │
 *          └────────────┘              ▼
 *          ┌────────────┐        ┌───────────┐        ┌─────────┐
 *   files  │ deterministic│─────▶│ assemble  │───────▶│  Entry  │─▶ commit
 *   ──────▶│   engine    │ Facts │  (pure)   │  valid └─────────┘
 *          └────────────┘        └───────────┘
 *          ┌────────────┐              ▲
 *   human  │  curator   │──────────────┘
 *   ──────▶│ overrides  │ CuratorOverrides (optional)
 *          └────────────┘
 *
 * NOTHING downstream trusts the LLM's structure: `assembleEntry` re-derives ids,
 * resolves every proposed link against the real id set, and drops anything that
 * does not typecheck. The LLM can be wrong; it cannot make the KB invalid.
 */
import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════════
// 1 · BRANDED PRIMITIVES  — illegal values cannot be constructed by accident
// ════════════════════════════════════════════════════════════════════════════

/** kb-<domain>-<7 alphanumerics>. A plain string can never be used where an
 *  EntryId is required without going through the parser. */
export const EntryId = z
  .string()
  .regex(/^kb-[a-z0-9]+-[0-9A-Za-z]{7}$/, "must be kb-<domain>-<7id>")
  .brand<"EntryId">();
export type EntryId = z.infer<typeof EntryId>;

export const DomainId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .brand<"DomainId">();
export type DomainId = z.infer<typeof DomainId>;

/** sec-<domain>-<6 alphanumerics>. */
export const SectionId = z
  .string()
  .regex(/^sec-[a-z0-9]+-[0-9A-Za-z]{6}$/, "must be sec-<domain>-<6id>")
  .brand<"SectionId">();
export type SectionId = z.infer<typeof SectionId>;

/** YYYY-MM-DD, calendar-valid. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real date")
  .brand<"IsoDate">();
export type IsoDate = z.infer<typeof IsoDate>;

/** lower-kebab controlled token (tags, facet values, labels). */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .brand<"Slug">();
export type Slug = z.infer<typeof Slug>;

// ════════════════════════════════════════════════════════════════════════════
// 2a · SECTION TREE — the hard single-parent backbone
// ════════════════════════════════════════════════════════════════════════════

/** A section tree node — emergent, created by routing/split/crystallize. */
export const Section = z.object({
  id: SectionId,
  domain: DomainId,
  parent: SectionId.nullable(), // null = root
  depth: z.number().int().min(0),
  label: Slug,
  title: z.string().min(3).max(140),
  centroid: z.array(z.number()).length(768),
  memberCount: z.number().int().min(0),
  childIds: z.array(SectionId),
  summary: z.string().min(1),
  summaryHash: z.string(),
  dirty: z.boolean().default(false),
  created: IsoDate,
  updated: IsoDate,
});
export type Section = z.infer<typeof Section>;

/** How an entry was placed in its section. */
export const PlacementBasis = z.enum(["routed", "curator-pinned", "crystallized", "declared"]);
export type PlacementBasis = z.infer<typeof PlacementBasis>;

export const Placement = z.object({
  basis: PlacementBasis,
  fit: z.number().min(0).max(1),
});
export type Placement = z.infer<typeof Placement>;

// ════════════════════════════════════════════════════════════════════════════
// 2 · CONTROLLED VOCABULARIES  — closed sets. Grow them deliberately, in code.
// ════════════════════════════════════════════════════════════════════════════

/** Document kind. Strict. The `other` escape hatch is handled by the Kind union
 *  below so that an unknown kind is forced to carry a staging `tag`. */
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

export const Confidence = z.enum(["low", "medium", "high", "verified"]);
export type Confidence = z.infer<typeof Confidence>;

/** Lifecycle maturity — lets the KB track how knowledge *grows*, not just exists.
 *  Derived initially, promotable by curator. (NEW — see analysis note.) */
export const Maturity = z.enum([
  "stub", // thin / auto-ingested, needs development
  "draft", // substantive but unverified
  "active", // normal curated knowledge
  "canonical", // the authoritative hub for its topic (high centrality)
  "deprecated", // kept for history, not current truth
]);
export type Maturity = z.infer<typeof Maturity>;

/** Where this knowledge sits in time. */
export const Currency = z.enum(["live", "snapshot", "archived"]);
export type Currency = z.infer<typeof Currency>;



/** Typed, directional relationships. Replaces the flat, LLM-authored `related[]`
 *  that produced invented slugs. (NEW — see analysis note.)
 *  - see_also/similar  : DERIVED from embedding k-NN (deterministic)
 *  - the rest          : semantic; an LLM may PROPOSE them, but each is
 *                        validated against the real id set before it is kept. */
export const RelationKind = z.enum([
  "see_also", // generic relatedness (embedding-derived)
  "refines", // adds detail to a broader entry
  "part_of", // component/parent containment
  "depends_on", // requires another system/decision
  "supersedes", // replaces an older entry
  "contradicts", // factual conflict (flag for curation)
]);
export type RelationKind = z.infer<typeof RelationKind>;

/** Provenance of a relation — so we always know who asserted an edge. */
export const EdgeSource = z.enum(["embedding", "llm", "human"]);
export type EdgeSource = z.infer<typeof EdgeSource>;

/** Controlled facets replace the free-text `subcategory`. Open map of
 *  facet → Slug value; which facet keys are legal per domain is itself a
 *  code-owned registry (see FacetRegistry below). (NEW) */
export const FACET_KEYS = ["subsystem", "surface", "layer", "lifecycle"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/**
 * Coerce a raw facets object down to the controlled vocabulary: keep only keys
 * in FACET_KEYS whose value is a valid Slug, and silently DROP everything else
 * (unknown keys, non-slug values). This mirrors the drop-don't-fail rule used
 * for proposedRelations — a stray or mistyped facet from the model must never
 * fail the whole produce call and strand an otherwise-good entry. The closed
 * vocabulary is still enforced; we just discard the noise instead of throwing.
 */
export function coerceFacets(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((FACET_KEYS as readonly string[]).includes(k) && Slug.safeParse(v).success) {
      out[k] = v as string;
    }
  }
  return out;
}

/**
 * PROPERTIES — the OPEN counterpart to facets. Facets are a closed navigation
 * vocabulary (classify on 4 axes); properties are free-form structured
 * attributes the source genuinely carries but that are not classification axes
 * (host, region, test-count, export-surfaces, …). Keys are normalized to
 * lower-kebab; values are coerced to a single string (numbers/bools stringified,
 * arrays of primitives joined, nested objects dropped). Bounded + drop-don't-
 * fail, so a messy attribute bag never strands the entry. As recurring keys
 * emerge here, promote them into a controlled FacetRegistry (option 3).
 */
function slugifyKey(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // split camelCase word boundaries
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function coercePropertyValue(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t.slice(0, 300) : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v
      .filter((x) => ["string", "number", "boolean"].includes(typeof x))
      .map((x) => String(x).trim())
      .filter(Boolean);
    return parts.length ? parts.join(", ").slice(0, 300) : null;
  }
  return null; // objects / null / undefined are dropped
}

export function coerceProperties(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 30) break; // bound the bag
    const key = slugifyKey(k);
    if (!key) continue;
    const val = coercePropertyValue(v);
    if (val == null) continue;
    out[key] = val;
    n++;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · DISCRIMINATED UNIONS  — the "make illegal states unrepresentable" core
// ════════════════════════════════════════════════════════════════════════════

/** Kind: a known kind, OR `other` which MUST carry a staging tag. You cannot
 *  construct an `other` kind without a tag — the compiler forbids it. */
export const Kind = z.discriminatedUnion("type", [
  z.object({ type: z.enum(ENTRY_KINDS) }),
  z.object({ type: z.literal("other"), tag: Slug }),
]);
export type Kind = z.infer<typeof Kind>;

/** A single typed edge. `weight` present only for embedding-derived edges. */
export const Relation = z.object({
  kind: RelationKind,
  target: EntryId,
  source: EdgeSource,
  weight: z.number().min(0).max(1).optional(),
});
export type Relation = z.infer<typeof Relation>;

// ════════════════════════════════════════════════════════════════════════════
// 4 · THE THREE OWNERSHIP LAYERS  — non-overlapping authorities
// ════════════════════════════════════════════════════════════════════════════

/**
 * LLM OPINION — the ONLY thing the model is allowed to return. Deliberately
 * narrow. No ids, no dates, no links-by-id, no derived structure. Prose +
 * closed-vocabulary classification + *candidate* relations expressed as free
 * text that code must resolve. This is the entire nondeterministic surface.
 */
export const LlmOpinion = z.object({
  title: z.string().min(3).max(140),
  kind: Kind,
  summary: z.string().min(1), // one paragraph
  detail: z.string().min(1), // body
  context: z.string().optional(),
  confidence: Confidence,
  /** Controlled facet values the model is confident about. Unknown keys and
   *  non-slug values are stripped (coerceFacets) rather than failing the parse,
   *  so a bad facet never strands the entry. */
  facets: z
    .preprocess(coerceFacets, z.record(z.enum(FACET_KEYS), Slug))
    .default({}),
  /** Open structured attributes from the source that are NOT classification
   *  axes (host, region, test-count, …). Keys normalized, values stringified,
   *  bag bounded; junk is dropped rather than failing the parse. */
  properties: z
    .preprocess(coerceProperties, z.record(z.string(), z.string()))
    .default({}),
  /** Candidate semantic relations as (kind, free-text target hint). Code resolves
   *  the hint to a real EntryId via embeddings; unresolved hints are DROPPED. */
  proposedRelations: z
    .array(z.object({ kind: RelationKind, targetHint: z.string() }))
    .max(8)
    .default([]),
});
export type LlmOpinion = z.infer<typeof LlmOpinion>;

/**
 * DERIVED FACTS — produced entirely by deterministic engine code. The LLM may
 * not touch any of these.
 */
export const DerivedFacts = z.object({
  id: EntryId,
  domain: DomainId,
  created: IsoDate,
  updated: IsoDate,
  /** sha256 of the embedded text — ties entry⇄vector, drives dedup. */
  contentHash: z.string(),
  currency: Currency.default("live"),
  asOf: IsoDate.optional(),
  /** Deterministic + resolved relations (embedding see_also ∪ resolved LLM edges). */
  relations: z.array(Relation).default([]),
  /** Section placement (required, single-parent tree). */
  section: SectionId,
  /** How this entry was placed in its section. */
  placement: Placement,
});
export type DerivedFacts = z.infer<typeof DerivedFacts>;

/** CURATOR OVERRIDES — the human's lever. Optional, always wins. */
export const CuratorOverrides = z
  .object({
    authority: z.enum(["claim", "curated"]).default("curated"),
    maturity: Maturity.optional(),
    verified: z.boolean().default(false),
    /** Pinned relations a human asserts (never auto-removed). */
    pinnedRelations: z.array(Relation).default([]),
    /** Curator-pinned section placement (overrides routing). */
    pinnedSection: SectionId.optional(),
    expires: IsoDate.optional(),
  })
  .partial();
export type CuratorOverrides = z.infer<typeof CuratorOverrides>;

// ════════════════════════════════════════════════════════════════════════════
// 5 · THE ASSEMBLED ENTRY  — composition of the three layers (code owns this)
// ════════════════════════════════════════════════════════════════════════════

export const Entry = z.object({
  // identity + provenance (derived)
  id: EntryId,
  domain: DomainId,
  contentHash: z.string(),
  created: IsoDate,
  updated: IsoDate,
  // opinion (validated)
  title: z.string(),
  kind: Kind,
  summary: z.string(),
  detail: z.string(),
  context: z.string().optional(),
  confidence: Confidence,
  facets: z.record(z.enum(FACET_KEYS), Slug),
  properties: z.record(z.string(), z.string()).default({}),
  // structure (derived)
  relations: z.array(Relation),
  section: SectionId,
  placement: Placement,
  // lifecycle (derived default, curator-overridable)
  authority: z.enum(["claim", "curated"]),
  maturity: Maturity,
  currency: Currency,
  verified: z.boolean(),
  asOf: IsoDate.optional(),
  expires: IsoDate.optional(),
});
export type Entry = z.infer<typeof Entry>;

// ════════════════════════════════════════════════════════════════════════════
// 6 · THE ASSEMBLER  — pure, deterministic. The LLM never produces an Entry.
// ════════════════════════════════════════════════════════════════════════════

/** Resolve an LLM relation hint to a real id. Injected so the resolver (embedding
 *  nearest-neighbor + id lookup) stays in the engine and this file stays pure. */
export type RelationResolver = (
  hint: string,
  kind: RelationKind
) => { target: EntryId; weight?: number } | null;

/**
 * Compose the final Entry. Deterministic: given the same inputs it always yields
 * the same Entry. Illegal opinion is already impossible (parsed by LlmOpinion);
 * here we additionally guarantee referential integrity and derive lifecycle.
 */
export function assembleEntry(input: {
  opinion: LlmOpinion;
  facts: DerivedFacts;
  overrides?: CuratorOverrides;
  resolve: RelationResolver;
}): Entry {
  const { opinion, facts, overrides = {}, resolve } = input;

  // Resolve LLM-proposed edges to real ids; drop the unresolvable (no invented
  // slugs ever reach disk). Merge with derived + pinned, dedupe by (kind,target).
  const resolved: Relation[] = [];
  for (const p of opinion.proposedRelations) {
    const hit = resolve(p.targetHint, p.kind);
    if (hit && hit.target !== facts.id)
      resolved.push({ kind: p.kind, target: hit.target, source: "llm", weight: hit.weight });
  }
  const seen = new Set<string>();
  const relations = [...facts.relations, ...resolved, ...(overrides.pinnedRelations ?? [])]
    .filter((r) => {
      const k = `${r.kind}:${r.target}`;
      return r.target !== facts.id && !seen.has(k) && seen.add(k);
    });

  // Maturity: curator wins; else derive from confidence + relations.
  const maturity: Maturity =
    overrides.maturity ??
    (relations.length === 0
      ? "stub"
      : opinion.confidence === "low"
        ? "draft"
        : "active");

  // Section: curator pin wins, else use routed section.
  const section = overrides.pinnedSection ?? facts.section;
  const placement: Placement = overrides.pinnedSection
    ? { basis: "curator-pinned", fit: 1.0 }
    : facts.placement;

  return Entry.parse({
    id: facts.id,
    domain: facts.domain,
    contentHash: facts.contentHash,
    created: facts.created,
    updated: facts.updated,
    title: opinion.title,
    kind: opinion.kind,
    summary: opinion.summary,
    detail: opinion.detail,
    context: opinion.context,
    confidence: opinion.confidence,
    facets: opinion.facets,
    properties: opinion.properties,
    relations,
    section,
    placement,
    authority: overrides.authority ?? "curated",
    maturity,
    currency: facts.currency,
    verified: overrides.verified ?? false,
    asOf: facts.asOf,
    expires: overrides.expires,
  });
}
