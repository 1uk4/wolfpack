/**
 * Registry — the bidirectional hub. Projected from the ledger, rendered to
 * kb-base/registry/topics.md (read-only to wolves).
 *
 * Connects three node types: wolves ↔ den topics (aliases) ↔ KB entries,
 * plus the subscriber set that powers kb-feed fan-out.
 */
import { z } from "zod";

export const AliasSchema = z.object({
  wolf: z.string(),
  denTopicId: z.string(),
  lastHash: z.string(),
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
  /** Wolves that receive kb-feed notices (implicit subscription). */
  subscribers: z.array(z.string()),
  updated: z.string(),
});
export type RegistryTopic = z.infer<typeof RegistryTopicSchema>;

export type Registry = Map<string, RegistryTopic>;
