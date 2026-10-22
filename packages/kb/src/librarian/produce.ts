/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import type { Engine } from "@wolfpack/engine";
import { parseFrontmatter, PRODUCE_SYSTEM } from "@wolfpack/engine";
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
import {
  lintKnowledge, hardFindings, describeFindings, stripProperties, stripLedeRepeat, stripDetailHeading,
  type LintFinding,
} from "../shared/knowledgeLint.js";
import { anchorOf } from "./anchors.js";
import { addCitedHistory, existingRelations, foldIntro, normalizeDetail, preserveHistory } from "./preserve.js";

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
  /** Existing entry markdown for merge context */
  existingMarkdown?: string;
  /** `created` date of the entry being updated, kept on merge (read from
   *  existingMarkdown when not given). */
  existingCreated?: string;
  /** Resolver for proposed relations (embedding NN + id lookup) */
  resolve: RelationResolver;
  /** Curator overrides (optional) */
  overrides?: CuratorOverrides;
}

export interface ProduceEntryResult {
  entry: Entry;
  action: "create" | "merge";
  /** Decision entries are never rewritten: the contribution agreed with the
   *  existing decision, so `entry` is a discarded draft and nothing is committed. */
  unchanged?: boolean;
  /** Id of the decision the new `entry` replaces (it also carries the relation). */
  supersedes?: string;
  /** History lines of the previous entry the model dropped and code restored. */
  historyRestored?: string[];
  /** Knowledge-lint outcome on the model's output. */
  lint?: { retried: boolean; before: LintFinding[]; after: LintFinding[] };
}

/**
 * Lint what the model wrote, ignoring lines the entry already carried (a merge
 * keeps old History lines verbatim, so their content is not the model's fault).
 */
export function lintOpinion(o: LlmOpinion, previous: string | undefined): LintFinding[] {
  const old = new Set((previous ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  // The History heading stays: it tells the lint where History lines begin.
  const body = o.detail.split("\n").filter((l) => !old.has(l.trim()) || /^## History[ \t]*$/.test(l)).join("\n");
  // Content checks look at what is new; size counts the whole entry the reader gets.
  const fresh = lintKnowledge({ title: o.title, summary: o.summary, body, properties: o.properties, cap: Infinity });
  const size = lintKnowledge({ body: o.detail, extraChars: o.summary.length }).filter((f) => f.code === "oversize");
  return [...fresh, ...size];
}

/** True when the entry markdown declares `kind: decision`. */
export function isDecisionMarkdown(markdown: string): boolean {
  return parseFrontmatter(markdown).fields.kind === "decision";
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
  const { contribution, domain, section, placement, entryId, existingMarkdown, existingCreated, resolve, overrides } = input;
  const previous = existingMarkdown;
  const action: ProduceEntryResult["action"] = entryId ? "merge" : "create";

  // Build LLM prompt (bounded, context-aware)
  const prompt = [
    `DOMAIN: ${domain}`,
    `CONTRIBUTION (from ${contribution.from}):`,
    contribution.summary,
    "",
    contribution.body,
    existingMarkdown ? `\nEXISTING ENTRY (${entryId}):\n${existingMarkdown}` : "",
    `\nCONTRIBUTION DATE: ${contribution.sourceUpdated ?? now().slice(0, 10)}`,
    `ACTION: ${action}`,
  ].join("\n");

  // LLM call — returns ONLY opinion (no ids, dates, section, resolved relations).
  // Re-parse through the schema to guarantee branded types AND re-validate the
  // model output (the confinement firewall — nothing invalid reaches assemble).
  const shape = (raw: unknown): LlmOpinion => {
    const o = LlmOpinion.parse(raw);
    // The entry renders as H1 + lede + detail: the detail must not repeat them.
    const detail = normalizeDetail(o.detail, o.summary, previous);
    return LlmOpinion.parse({ ...o, ...foldIntro(o.summary, detail, previous) });
  };
  let opinion = shape(await engine.call("produce", LlmOpinion, { system: PRODUCE_SYSTEM, prompt }));

  // Last line of defence against changelog content: lint, ONE retry with the
  // findings, then strip what can be stripped safely.
  const before = lintOpinion(opinion, previous);
  let retried = false;
  if (hardFindings(before).length || before.some((f) => f.code === "oversize")) {
    retried = true;
    opinion = shape(
      await engine.call("produce", LlmOpinion, {
        system: PRODUCE_SYSTEM,
        prompt: `${prompt}\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS:\n${describeFindings(before)}\nWrite the entry again and fix every one. If the body is over the size cap, cut redundancy and anything off the entry's subject (never drop History lines). Commit hashes, task ids, test counts, deploy status and dated headings are never part of an entry; a work id appears only as the closing citation of a History line; History lines carry dates and reasons only.`,
      })
    );
  }
  opinion = LlmOpinion.parse({
    ...opinion,
    properties: stripProperties(opinion.properties),
    detail: stripLedeRepeat(opinion.summary, stripDetailHeading(opinion.detail)),
  });
  const lint = { retried, before, after: lintOpinion(opinion, previous) };

  // Build DerivedFacts deterministically
  // A decision is never rewritten in place: a contradicting contribution
  // becomes a NEW decision that supersedes it, an agreeing one changes nothing.
  const decisionTarget = !!(entryId && existingMarkdown && isDecisionMarkdown(existingMarkdown));
  const supersedes = decisionTarget && opinion.supersedesDecision ? EntryId.parse(entryId) : undefined;
  const mergeId = supersedes ? undefined : entryId;
  const id = EntryId.parse(mergeId ?? mkEntryId(domain));
  const timestamp = IsoDate.parse(now().slice(0, 10));
  // On merge the entry keeps its original creation date.
  const kept = IsoDate.safeParse(
    existingCreated ?? (previous ? String(parseFrontmatter(previous).fields.created ?? "") : "")
  );
  const created = mergeId && kept.success ? kept.data : timestamp;

  // Code-side guard: History lines are never lost on an update.
  let historyRestored: string[] = [];
  if (mergeId && previous && !(decisionTarget && !supersedes)) {
    const kept = preserveHistory(previous, opinion.detail);
    historyRestored = kept.restored;
    if (kept.restored.length) opinion = LlmOpinion.parse({ ...opinion, detail: kept.detail });
  }

  // Graduated work's cited History lines always reach the entry.
  const cited = addCitedHistory(opinion.detail, contribution.body);
  if (cited.added.length && !(decisionTarget && !supersedes)) opinion = LlmOpinion.parse({ ...opinion, detail: cited.detail });

  // Compute content hash from the opinion prose
  const contentText = [opinion.title, opinion.summary, opinion.detail].join("\n");
  const contentHashValue = hashContent(contentText);

  const facts: DerivedFacts = {
    id,
    domain: DomainId.parse(domain),
    created,
    updated: timestamp,
    contentHash: contentHashValue,
    currency: contribution.currency === "archived" ? "archived" : "live",
    asOf: contribution.sourceUpdated ? IsoDate.parse(contribution.sourceUpdated) : undefined,
    // The anchor is the entry's identity: an anchored contribution sets it, a merge keeps it.
    anchor: contribution.anchor ?? (mergeId && previous ? anchorOf(previous) : undefined),
    relations: [
      // An update keeps the entry's existing links (the model never sees them).
      ...(mergeId && previous ? existingRelations(previous) : []),
      ...(supersedes ? [{ kind: "supersedes" as const, target: supersedes, source: "code" as const, weight: 1 }] : []),
    ],
    section,
    placement,
  };

  // Assemble the final entry (validates, resolves proposed relations, drops unresolved)
  const entry = assembleEntry({ opinion, facts, overrides, resolve });

  if (decisionTarget) {
    return supersedes
      ? { entry: { ...entry, kind: { type: "decision" } }, action: "create", supersedes }
      : { entry, action: "merge", unchanged: true };
  }
  return { entry, action, historyRestored, lint };
}
