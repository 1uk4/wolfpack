/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import type { Engine } from "@wolfpack/engine";
import { PRODUCE_SYSTEM } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";
import { entryId as mkEntryId, now } from "../shared/index.js";
import {
  type Entry,
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

// ═══════════════════════════════════════════════════════════════════════════
// assemble-based produce (LlmOpinion ⊕ DerivedFacts ⊕ Curator)
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
  /** Id to give a NEW entry (instead of a random one), e.g. derived from a work id */
  newEntryId?: string;
  /** Existing entry markdown for merge context */
  existingMarkdown?: string;
  /** Resolver for proposed relations (embedding NN + id lookup) */
  resolve: RelationResolver;
  /** Curator overrides (optional) */
  overrides?: CuratorOverrides;
}

export interface ProduceEntryResult {
  entry: Entry;
  action: "create" | "merge";
}

/**
 * Produce an entry using the three-layer architecture.
 * The LLM returns ONLY an LlmOpinion (prose + classification + relation hints).
 * Code builds DerivedFacts deterministically, resolves relations, and assembles.
 */
export async function produceEntry(
  engine: Engine,
  input: ProduceEntryInput
): Promise<ProduceEntryResult> {
  const { contribution, domain, section, placement, entryId, newEntryId, existingMarkdown, resolve, overrides } = input;
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
  const id = EntryId.parse(entryId ?? newEntryId ?? mkEntryId(domain));
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
