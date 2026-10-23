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
  lintKnowledge, hardFindings, describeFindings, stripProperties, stripLedeRepeat, stripDetailHeading, stripBrokenLinks, splitHistory,
  DEFAULT_BODY_CAP,
  type LintFinding,
} from "../shared/knowledgeLint.js";
import { anchorOf } from "./anchors.js";
import { deliveredBullets, mergeDelivered } from "../shared/index.js";
import { addCitedHistory, dedupeDetail, existingRelations, foldIntro, historyLines, normalizeDetail, preserveHistory } from "./preserve.js";

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
  /** Ids of every live entry (any domain): a `[[link]]` to anything else is a lint finding. */
  liveIds?: ReadonlySet<string>;
  /** The model may return a second subject as `overflow` (default true; the
   *  overflow's own produce passes false, so a split never recurses). */
  allowOverflow?: boolean;
}

/** A second subject the model split out of the contribution, to be routed as its own contribution. */
export interface ProduceOverflow {
  title: string;
  summary: string;
  body: string;
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
  lint?: { retried: boolean; sizePass?: boolean; before: LintFinding[]; after: LintFinding[]; oversizeChars?: number; strippedLinks?: string[] };
  /** A second subject for the sweep to route like a new contribution. */
  overflow?: ProduceOverflow;
  /** Near-duplicate paragraphs/bullets/History lines collapsed in code. */
  deduped?: string[];
}

/**
 * Lint what the model wrote, ignoring lines the entry already carried (a merge
 * keeps old History lines verbatim, so their content is not the model's fault).
 */
export function lintOpinion(o: LlmOpinion, previous: string | undefined, liveIds?: ReadonlySet<string>): LintFinding[] {
  const old = new Set((previous ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  // The History heading stays: it tells the lint where History lines begin.
  const body = o.detail.split("\n").filter((l) => !old.has(l.trim()) || /^## History[ \t]*$/.test(l)).join("\n");
  // Content checks look at what is new; size counts the whole entry the reader gets.
  const fresh = lintKnowledge({ title: o.title, summary: o.summary, body, properties: o.properties, cap: Infinity, liveIds });
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
  const { contribution, domain, section, placement, entryId, existingMarkdown, existingCreated, resolve, overrides, liveIds } = input;
  const allowOverflow = input.allowOverflow !== false;
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
    allowOverflow
      ? `OVERFLOW: allowed${existingMarkdown && splitHistory(parseFrontmatter(existingMarkdown).body).main.length > DEFAULT_BODY_CAP ? " (the EXISTING ENTRY is already over the size cap, so it covers more than one subject. The contribution was routed here: it stays in this entry. The entry's main subject is what most of its existing text and the contribution are about. Move the other, smaller subject of the EXISTING text into overflow, remove it from the entry, and retitle the entry only if its title named the moved subject)" : ""}`
      : "OVERFLOW: not allowed (leave out anything about another subject)",
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
  const oldLines = new Set((previous ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const stripped: string[] = [];
  const keepHistory = new Set((previous ? historyLines(previous) : []).map((l) => l.replace(/\s+/g, " ").trim()));
  // Properties, the repeated lede and the detail wrapper heading go in code; so
  // does a wikilink to no entry that survived the retry (brackets off, text kept).
  const clean = (o: LlmOpinion): LlmOpinion => {
    let detail = stripLedeRepeat(o.summary, stripDetailHeading(o.detail));
    let summary = o.summary;
    if (liveIds) {
      const d = stripBrokenLinks(detail, liveIds, oldLines);
      const sm = stripBrokenLinks(summary, liveIds);
      detail = d.text;
      summary = sm.text;
      stripped.push(...d.stripped, ...sm.stripped);
    }
    // A split-out subject leaves the entry: copies of it the model kept are dropped here.
    if (allowOverflow && o.overflow) {
      const dd = dedupeDetail(detail, keepHistory, o.overflow.detail);
      detail = dd.detail;
    }
    return LlmOpinion.parse({ ...o, summary, properties: stripProperties(o.properties), detail });
  };

  // Last line of defence against changelog content: lint, ONE retry with the
  // findings, then strip what can be stripped safely.
  const before = lintOpinion(opinion, previous, liveIds);
  let retried = false;
  if (hardFindings(before).length || before.some((f) => f.code === "oversize")) {
    retried = true;
    opinion = shape(
      await engine.call("produce", LlmOpinion, {
        system: PRODUCE_SYSTEM,
        prompt: `${prompt}\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS:\n${describeFindings(before)}\nWrite the entry again and fix every one. If the body is over the size cap${allowOverflow ? ", put material about a second subject in `overflow` (its own title, summary and detail) and otherwise" : ","} cut redundancy and anything off the entry's subject (never drop History lines). Commit hashes, task ids, test counts, deploy status and dated headings are never part of an entry; a work id appears only as the closing citation of a History line; History lines carry dates and reasons only. A [[link]] names a real entry id only: write anything else as plain words.`,
      })
    );
  }
  opinion = clean(opinion);
  let after = lintOpinion(opinion, previous, liveIds);
  // Only the size is left: one focused pass. Two subjects split (the second
  // becomes the overflow); one subject is condensed.
  let sizePass = false;
  if (after.length && after.every((f) => f.code === "oversize")) {
    sizePass = true;
    const split = allowOverflow && !opinion.overflow;
    const carried = opinion.overflow;
    opinion = shape(
      await engine.call("produce", LlmOpinion, {
        system: PRODUCE_SYSTEM,
        prompt: `${prompt}\n\nYOUR LAST ANSWER (the detail below is over the size cap):\n${opinion.detail}\n\n${describeFindings(after)}\n${
          split
            ? `If the body covers TWO subjects (the second may already be in the existing entry), keep the subject the contribution belongs to (≤ ${DEFAULT_BODY_CAP} chars, History excluded) and return the other subject in \`overflow\` (title, summary, detail) instead of condensing it. If it is ONE subject, condense the body to ≤ ${DEFAULT_BODY_CAP} chars: cut redundancy and repetition.`
            : `Condense the body to ≤ ${DEFAULT_BODY_CAP} chars (History excluded): cut redundancy and repetition.`
        } Keep History exactly as it is; add nothing.`,
      })
    );
    // A second subject already split out stays split out, whatever the pass returns.
    opinion = clean(carried ? { ...opinion, overflow: carried } : opinion);
    after = lintOpinion(opinion, previous, liveIds);
  }
  // A split ends with the entry under the cap; an overflow only the first
  // produce asked for leaves the entry as it is.
  const overflow: ProduceOverflow | undefined =
    allowOverflow && opinion.overflow
      ? { title: opinion.overflow.title, summary: opinion.overflow.summary, body: opinion.overflow.detail }
      : undefined;
  const oversize = after.find((f) => f.code === "oversize");
  const lint = {
    retried, sizePass, before, after,
    oversizeChars: oversize ? Number(/(\d+) chars/.exec(oversize.message)?.[1]) || undefined : undefined,
    strippedLinks: stripped.length ? [...new Set(stripped)] : undefined,
  };

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

  // An initiative's Delivered links (built in code from the features' link-back
  // notes) are never lost: the entry's own plus the contribution's are re-added.
  const delivered = [...(previous && mergeId ? deliveredBullets(previous) : []), ...deliveredBullets(contribution.body)];
  if (delivered.length && !(decisionTarget && !supersedes)) {
    opinion = LlmOpinion.parse({ ...opinion, detail: mergeDelivered(opinion.detail, delivered) });
  }

  // Graduated work's cited History lines always reach the entry.
  const cited = addCitedHistory(opinion.detail, contribution.body);
  if (cited.added.length && !(decisionTarget && !supersedes)) opinion = LlmOpinion.parse({ ...opinion, detail: cited.detail });

  // No duplicate content: near-identical paragraphs/bullets and History lines
  // that restate the same change are collapsed (the previous History is kept).
  let deduped: string[] | undefined;
  if (!(decisionTarget && !supersedes)) {
    const dd = dedupeDetail(opinion.detail, keepHistory);
    if (dd.removed.length) {
      deduped = dd.removed;
      opinion = LlmOpinion.parse({ ...opinion, detail: dd.detail });
    }
  }

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
  return { entry, action, historyRestored, lint, overflow, deduped };
}
