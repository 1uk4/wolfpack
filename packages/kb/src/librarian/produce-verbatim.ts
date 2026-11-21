/**
 * produce-verbatim — produce for anchored verbatim contributions (no LLM).
 * Split out of produce.ts; produce.ts re-exports these.
 */
import { parseFrontmatter } from "@wolfpack/engine";
import type { ParsedContribution } from "../shared/index.js";
import { entryId as mkEntryId, now } from "../shared/index.js";
import { type DerivedFacts, LlmOpinion, assembleEntry, DomainId, EntryId, IsoDate } from "../schema/knowledge.js";
import { contentHash as hashContent } from "../shared/hash.js";
import { anchorOf, groupDateOf, groupOf } from "./anchors.js";
import { entryHashText } from "./entry-hash.js";
import { existingRelations } from "./preserve.js";
import type { ProduceEntryInput, ProduceEntryResult } from "./produce.js";


/** The entry's text split the way produce hashes it: title, summary, detail. */
export function verbatimParts(c: Pick<ParsedContribution, "body" | "summary" | "denTopicId">): { title: string; summary: string; detail: string } {
  const body = (c.body ?? "").trim();
  const h1 = /^#[ \t]+(.+?)[ \t]*(?:\n+|$)/.exec(body);
  const title = (h1?.[1] ?? c.denTopicId.replace(/[-_]+/g, " ")).trim().slice(0, 140).padEnd(3, " ");
  const detail = (h1 ? body.slice(h1[0].length) : body).trim();
  const summary = c.summary.trim() || title;
  return { title, summary, detail: detail || summary };
}

/**
 * Produce an anchored entry whose body is kept as authored: no model call, no
 * knowledge lint, no size or overflow pass. The title is the body's `# title`,
 * the summary the contribution's, the detail the rest of the body. A
 * contribution to the anchor's existing entry replaces its whole text and keeps
 * its identity (id, anchor, group, creation date, relations).
 */
export function produceVerbatim(input: ProduceEntryInput): ProduceEntryResult {
  const { contribution, domain, section, placement, entryId, existingMarkdown, existingCreated, resolve } = input;
  const previous = existingMarkdown;
  const action: ProduceEntryResult["action"] = entryId ? "merge" : "create";
  const parts = verbatimParts(contribution);
  const opinion = LlmOpinion.parse({
    title: parts.title,
    kind: "fact",
    summary: parts.summary,
    detail: parts.detail,
    confidence: "high",
  });

  const id = EntryId.parse(entryId ?? mkEntryId(domain));
  const timestamp = IsoDate.parse(now().slice(0, 10));
  const kept = IsoDate.safeParse(
    existingCreated ?? (previous ? String(parseFrontmatter(previous).fields.created ?? "") : "")
  );
  const created = entryId && kept.success ? kept.data : timestamp;
  const prev = entryId ? previous : undefined;

  const facts: DerivedFacts = {
    id,
    domain: DomainId.parse(domain),
    created,
    updated: timestamp,
    contentHash: hashContent(entryHashText(opinion.title, opinion.summary, opinion.detail)),
    currency: contribution.currency === "archived" ? "archived" : "live",
    asOf: contribution.sourceUpdated ? IsoDate.parse(contribution.sourceUpdated) : undefined,
    anchor: contribution.anchor ?? (prev ? anchorOf(prev) : undefined),
    group: contribution.group ?? (prev ? groupOf(prev) : undefined),
    groupDate: contribution.groupDate ?? (prev ? groupDateOf(prev) : undefined),
    relations: prev ? existingRelations(prev) : [],
    section,
    placement,
  };
  const entry = assembleEntry({ opinion, facts, overrides: input.overrides, resolve });
  // Same text and same identity as the entry on disk: nothing to write.
  if (prev) {
    const f = parseFrontmatter(prev).fields;
    if (String(f.contentHash ?? "") === entry.contentHash && facts.anchor === anchorOf(prev) && facts.group === groupOf(prev) && facts.groupDate === groupDateOf(prev)) {
      return { entry, action, unchanged: true };
    }
  }
  return { entry, action };
}
