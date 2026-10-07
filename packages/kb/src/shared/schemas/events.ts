/**
 * Ledger events — the single append-only source of truth.
 *
 * Clusters, the registry, aliases, and subscriptions are ALL pure projections
 * of this log (see librarian/ledger.ts foldRegistry / foldClusters). This
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
    t: z.literal("crystallized_v2"),
    sectionId: z.string(),
    parentId: z.string(),
    entryIds: z.array(z.string()),
    cohesion: z.number(),
  }),
]);

export type KbEvent = z.infer<typeof KbEventSchema>;
