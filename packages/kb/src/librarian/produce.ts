/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import type { Engine } from "@wolfpack/engine";
import { z } from "zod";
import { PRODUCE_SYSTEM, EntrySchema, ENTRY_TYPES, type Entry } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";
import { entryId as mkEntryId, topicId as mkTopicId, now } from "../shared/index.js";
import type { RouteDecision } from "./route.js";
import { normalizeEntry } from "./normalize.js";
import {
  type Entry as EntryV2,
  LlmOpinion,
  type DerivedFacts,
  type CuratorOverrides,
  type SectionId,
  type Placement,
  type RelationResolver,
  assembleEntry,
  DomainId,
  EntryId,
  IsoDate,
} from "../schema/knowledge.js";
import { contentHash as hashContent } from "../shared/hash.js";

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
  existing?: { id: string; markdown: string },
  knownIds?: Set<string>
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

  // Deterministic guardrails: the LLM cannot own frontmatter integrity.
  // A new entry's own (just-generated) id is legitimately not yet in knownIds;
  // include it so a self-link check still fires correctly.
  const ids = knownIds ? new Set([...knownIds, id]) : undefined;
  const { entry: normalized, warnings } = normalizeEntry(entry, domain, ids);
  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`[kb:normalize] ${normalized.frontmatter.id}: ${w}`);
    }
  }

  return { entry: normalized, canonicalId, action };
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 PATH — assemble-based produce (LlmOpinion ⊕ DerivedFacts ⊕ Curator)
// ═══════════════════════════════════════════════════════════════════════════

export interface ProduceEntryInput {
  /** Contribution to process */
  contribution: ParsedContribution;
  /** Target domain */
  domain: string;
  /** Section placement (from router) */
  section: SectionId;
  placement: Placement;
  /** Entry id when merging/updating, or null for create */
  entryId?: string;
  /** Existing entry markdown for merge context */
  existingMarkdown?: string;
  /** Resolver for proposed relations (embedding NN + id lookup) */
  resolve: RelationResolver;
  /** Curator overrides (optional) */
  overrides?: CuratorOverrides;
}

export interface ProduceEntryResult {
  entry: EntryV2;
  action: "create" | "merge";
}

/**
 * V2: Produce an entry using the three-layer architecture.
 * The LLM returns ONLY an LlmOpinion (prose + classification + relation hints).
 * Code builds DerivedFacts deterministically, resolves relations, and assembles.
 */
export async function produceEntry(
  engine: Engine,
  input: ProduceEntryInput
): Promise<ProduceEntryResult> {
  const { contribution, domain, section, placement, entryId, existingMarkdown, resolve, overrides } = input;
  const action: ProduceEntryResult["action"] = entryId ? "merge" : "create";

  // Build LLM prompt (bounded, context-aware)
  const prompt = [
    `DOMAIN: ${domain}`,
    `CONTRIBUTION (from ${contribution.from}):`,
    contribution.summary,
    "",
    contribution.body,
    existingMarkdown ? `\nEXISTING ENTRY (${entryId}):\n${existingMarkdown}` : "",
    `\nACTION: ${action}`,
  ].join("\n");

  // LLM call — returns ONLY opinion (no ids, dates, section, resolved relations).
  // Re-parse through the schema to guarantee branded types AND re-validate the
  // model output (the confinement firewall — nothing invalid reaches assemble).
  const opinion = LlmOpinion.parse(
    await engine.call("produce", LlmOpinion, {
      system: PRODUCE_SYSTEM,
      prompt,
    })
  );

  // Build DerivedFacts deterministically
  const id = entryId ? EntryId.parse(entryId) : EntryId.parse(mkEntryId(domain));
  const timestamp = IsoDate.parse(now().slice(0, 10));
  
  // Compute content hash from the opinion prose
  const contentText = [opinion.title, opinion.summary, opinion.detail].join("\n");
  const contentHashValue = hashContent(contentText);

  const facts: DerivedFacts = {
    id,
    domain: DomainId.parse(domain),
    created: timestamp, // TODO: preserve from existing on merge
    updated: timestamp,
    contentHash: contentHashValue,
    currency: contribution.currency === "archived" ? "archived" : "live",
    asOf: contribution.sourceUpdated ? IsoDate.parse(contribution.sourceUpdated) : undefined,
    relations: [], // Embedding-derived see_also relations would go here (Phase 2 integration)
    section,
    placement,
  };

  // Assemble the final entry (validates, resolves proposed relations, drops unresolved)
  const entry = assembleEntry({ opinion, facts, overrides, resolve });

  return { entry, action };
}
