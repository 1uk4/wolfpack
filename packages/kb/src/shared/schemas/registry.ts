/**
 * Registry — the bidirectional hub. Projected from the ledger, rendered to
 * kb-base/registry/topics.md (read-only to wolves).
 *
 * Connects three node types: wolves ↔ den topics (aliases) ↔ KB entries,
 * plus the subscriber set (wolves that have contributed).
 */
import { z } from "zod";

export const AliasSchema = z.object({
  wolf: z.string(),
  denTopicId: z.string(),
  lastHash: z.string(),
  /** Normalized-body hash and digits-stripped shape hash of the body this alias last merged; absent on records written before claim-level dedupe (or by a backfill). */
  bodyHash: z.string().optional(),
  bodyShapeHash: z.string().optional(),
  lastSeen: z.string(),
});
export type Alias = z.infer<typeof AliasSchema>;

export const RegistryTopicSchema = z.object({
  canonicalId: z.string(),
  domain: z.string(),
  /** "" until crystallized. */
  subcategory: z.string(),
  /** Whether this topic has crystallized out of a singleton cluster. */
  crystallized: z.boolean(),
  /** Curated entries realizing this topic. */
  entries: z.array(z.string()),
  /** Per-wolf local-topic linkages. */
  aliases: z.array(AliasSchema),
  /** Wolves that have contributed to this topic (implicit subscription). */
  subscribers: z.array(z.string()),
  updated: z.string(),
});
export type RegistryTopic = z.infer<typeof RegistryTopicSchema>;

export type Registry = Map<string, RegistryTopic>;
