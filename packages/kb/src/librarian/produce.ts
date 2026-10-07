/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import type { Engine } from "@wolfpack/engine";
import { EntrySchema, type Entry } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";
import { entryId as mkEntryId, topicId as mkTopicId, now } from "../shared/index.js";
import type { RouteDecision } from "./route.js";

const PRODUCE_SYSTEM =
  "You write a single curated knowledge-base entry from a wolf's contribution. " +
  "Be precise and sourced. On merge, integrate the new information into the " +
  "existing entry, changing only what the contribution affects. Output JSON " +
  "matching the entry schema.";

export interface ProduceResult {
  entry: Entry;
  canonicalId: string;
  action: "create" | "merge" | "supersede";
}

/**
 * Produce the entry for a routed contribution.
 * `existing` is the current entry markdown when merging/superseding.
 */
export async function produce(
  engine: Engine,
  c: ParsedContribution,
  route: RouteDecision,
  domain: string,
  subcategory: string,
  existing?: { id: string; markdown: string }
): Promise<ProduceResult> {
  const merging = route.kind === "merge_known" || route.kind === "merge_near";
  const action: ProduceResult["action"] = merging ? "merge" : "create";

  const prompt = [
    `DOMAIN: ${domain}`,
    `SUBCATEGORY: ${subcategory}`,
    `CONTRIBUTION (from ${c.from}):`,
    c.summary,
    "",
    c.body,
    existing ? `\nEXISTING ENTRY (${existing.id}):\n${existing.markdown}` : "",
    `\nACTION: ${action}`,
  ].join("\n");

  const draft = await engine.call("produce", EntrySchema, {
    system: PRODUCE_SYSTEM,
    prompt,
  });

  const id = existing?.id ?? mkEntryId(domain);
  const canonicalId = route.canonicalId ?? mkTopicId();
  const timestamp = now().slice(0, 10);

  // Enforce invariants the model shouldn't own.
  const entry: Entry = {
    ...draft,
    frontmatter: {
      ...draft.frontmatter,
      id,
      domain,
      subcategory,
      status: draft.frontmatter.status ?? "active",
      authority: "curated",
      confidence: draft.frontmatter.confidence ?? "medium",
      related: draft.frontmatter.related ?? [],
      supersedes: draft.frontmatter.supersedes ?? [],
      sources: draft.frontmatter.sources ?? [],
      created: existing ? draft.frontmatter.created : timestamp,
      updated: timestamp,
      // Temporal provenance from the contribution (crawl/historical ingestion).
      asOf: c.sourceUpdated ?? draft.frontmatter.asOf,
      historical: c.currency === "archived" ? true : draft.frontmatter.historical ?? false,
    },
  };

  return { entry, canonicalId, action };
}
