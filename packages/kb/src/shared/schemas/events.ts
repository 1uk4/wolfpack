/**
 * Ledger events — the single append-only source of truth.
 *
 * Clusters, the registry, aliases, and subscriptions are ALL pure projections
 * of this log (see librarian/ledger.ts foldRegistry). This
 * mirrors the memory package's observation ledger + foldLedger pattern.
 */
import { z } from "zod";

/** The code-decided routing outcome for a contribution. */
export const RouteKindSchema = z.enum([
  "merge_known", // alias → existing entry, no LLM
  "merge_near", // embedding > duplicate threshold, no LLM
  "maybe_conflict", // high similarity + content diff → oracle:contradict
  "create", // no match
  "unclassified", // weak domainHint → oracle:classify
]);
export type RouteKind = z.infer<typeof RouteKindSchema>;

export const EntryActionSchema = z.enum(["create", "merge", "supersede"]);
export type EntryAction = z.infer<typeof EntryActionSchema>;

/** How the sweep routed a contribution: the RoutingRecord fields a receipt carries (sweep.ts), minus the overflow detail. */
export const DecisionRoutingSchema = z.object({
  route: z.enum(["alias", "anchor", "similarity", "new"]),
  /** Top-3 similarity candidates, best first. */
  candidates: z.array(z.object({ id: z.string(), score: z.number() })),
  band: z.string().optional(),
  subject: z.object({ match: z.string(), valid: z.boolean(), reason: z.string().optional() }).optional(),
  confirm: z
    .object({ candidate: z.string(), score: z.number(), merge: z.boolean(), valid: z.boolean(), reason: z.string().optional() })
    .optional(),
  /** The entry written. */
  target: z.string().optional(),
  warning: z.string().optional(),
});
export type DecisionRouting = z.infer<typeof DecisionRoutingSchema>;

/** What the curator decided for one contribution. `unchanged`: a merge the contribution agreed with (no entry text written). */
export const DecisionOutcomeSchema = z.enum(["create", "merge", "unchanged", "reject", "parked", "unclassified"]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** The decision summary shared by the ledger `decision` event and the sweep_item event. */
export const DecisionSummarySchema = z.object({
  outcome: DecisionOutcomeSchema,
  /** The resulting entry (create / merge / unchanged). */
  entryId: z.string().optional(),
  /** Why (reject / parked / unclassified). */
  reason: z.string().optional(),
  routing: DecisionRoutingSchema.optional(),
});
export type DecisionSummary = z.infer<typeof DecisionSummarySchema>;

const base = { id: z.string(), at: z.string() };

export const KbEventSchema = z.discriminatedUnion("t", [
  z.object({
    ...base,
    t: z.literal("contribution"),
    from: z.string(),
    denTopicId: z.string(),
    hash: z.string(),
    prevHash: z.string().nullable(),
    domainHint: z.string(),
  }),
  /** One per contribution per outcome (create, merge, unchanged, reject, parked, unclassified). Older ledgers have none; older readers skip it. */
  z.object({
    ...base,
    t: z.literal("decision"),
    from: z.string(),
    denTopicId: z.string(),
    hash: z.string(),
    ...DecisionSummarySchema.shape,
  }),
  z.object({
    ...base,
    t: z.literal("routed"),
    contribution: z.string(),
    kind: RouteKindSchema,
    target: z.string().optional(),
  }),
  z.object({
    ...base,
    t: z.literal("entry_written"),
    entryId: z.string(),
    canonicalId: z.string(),
    action: EntryActionSchema,
  }),
  /** An entry was removed from the KB on purpose. Drops it from its registry
   *  topic; a topic left with no entries is dropped with its aliases. */
  z.object({
    ...base,
    t: z.literal("entry_retired"),
    entryId: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    t: z.literal("rejected"),
    contribution: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    t: z.literal("aliased"),
    wolf: z.string(),
    denTopicId: z.string(),
    canonicalId: z.string(),
    hash: z.string(),
  }),
  z.object({
    ...base,
    t: z.literal("clustered"),
    contribution: z.string(),
    clusterId: z.string(),
    seeded: z.boolean(),
  }),
  z.object({
    ...base,
    t: z.literal("crystallized"),
    clusterId: z.string(),
    canonicalId: z.string(),
    domain: z.string(),
    subcategory: z.string(),
  }),
  z.object({
    ...base,
    t: z.literal("subscribed"),
    wolf: z.string(),
    canonicalId: z.string(),
  }),
  // legacy: the feed was removed; kept so historical ledgers still parse.
  z.object({
    ...base,
    t: z.literal("fed"),
    wolf: z.string(),
    canonicalId: z.string(),
    entryId: z.string(),
  }),
  z.object({
    ...base,
    t: z.literal("section_created"),
    sectionId: z.string(),
    domain: z.string(),
    parent: z.string().nullable(),
    label: z.string(),
  }),
  z.object({
    ...base,
    t: z.literal("section_split"),
    sectionId: z.string(),
    parentId: z.string(),
    childIds: z.array(z.string()),
  }),
  z.object({
    ...base,
    t: z.literal("entry_placed"),
    entryId: z.string(),
    sectionId: z.string(),
    basis: z.enum(["routed", "curator-pinned", "crystallized", "declared"]),
    fit: z.number(),
  }),
  z.object({
    ...base,
    t: z.literal("sections_replaced"),
    /** A rebuild replaced this domain's whole tree with this snapshot. */
    domain: z.string(),
    sections: z.array(z.record(z.string(), z.unknown())),
  }),
  z.object({
    ...base,
    t: z.literal("section_crystallized"),
    sectionId: z.string(),
    parentId: z.string(),
    entryIds: z.array(z.string()),
    cohesion: z.number(),
  }),
]);

export type KbEvent = z.infer<typeof KbEventSchema>;
