/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import { dropSourceProps, hideSourceProperties } from "./source-props.js";
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
import { anchorOf, groupDateOf, groupOf } from "./anchors.js";
import { entryHashText } from "./entry-hash.js";
import { deliveredBullets, mapDeliveredLinks, mergeDelivered } from "../shared/index.js";
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
  /** Maps `## Delivered` links to live entries: retired ids to their survivors, ids with none dropped. */
  resolveLinks?: (links: string[]) => string[];
  /** YYYY-MM-DD the contribution's facts date from; derived from the contribution when not given (see deriveOriginDate). */
  originDate?: string;
  /** YYYY-MM-DD of the existing entry's `updated:`; read from existingMarkdown when not given. */
  entryUpdated?: string;
  /** The alias route found the same claim with new figures: replace the figures in place, add nothing new. */
  updateInPlace?: boolean;
}

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/**
 * The date a contribution's facts date from, in order: the latest date in its own text (summary, body / Record lines),
 * else sourceUpdated, groupDate, sourceCreated (the feature's shipped/created dates graduation sets), else `submitted`.
 */
export function deriveOriginDate(c: Pick<ParsedContribution, "summary" | "body" | "sourceUpdated" | "groupDate" | "sourceCreated" | "submitted">): string | undefined {
  const inText = [...`${c.summary ?? ""}\n${c.body ?? ""}`.matchAll(DATE_RE)].map((m) => m[1]!).sort();
  if (inText.length) return inText[inText.length - 1];
  for (const d of [c.sourceUpdated, c.groupDate, c.sourceCreated, c.submitted]) {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(d ?? "");
    if (m) return m[0];
  }
  return undefined;
}

/** The entry's detail (body minus H1 and lede) split from its History; used by the older-contribution guard. */
function detailMainLines(body: string): string[] {
  return splitHistory(body).main.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
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
  /** The contribution was older than the entry and the model changed the body: its body was discarded, only History lines were added. */
  olderGuard?: { discarded: true; historyAdded: string[] };
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
  const fresh = lintKnowledge({ title: o.title, summary: o.summary, body, properties: dropSourceProps(o.properties), cap: Infinity, liveIds });
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
  const originDate = input.originDate ?? deriveOriginDate(contribution);
  const prevFields = previous ? parseFrontmatter(previous).fields : {};
  const entryUpdated = input.entryUpdated ?? (/^\d{4}-\d{2}-\d{2}/.exec(String(prevFields.updated ?? ""))?.[0]);
  if (previous && !originDate) console.warn(`produce: no origin date for ${contribution.from}/${contribution.denTopicId}, treating the contribution as newer`);
  const contributionIsOlder = !!(previous && originDate && entryUpdated && originDate < entryUpdated);

  // Build LLM prompt (bounded, context-aware)
  const prompt = [
    `DOMAIN: ${domain}`,
    `CONTRIBUTION (from ${contribution.from}):`,
    contribution.summary,
    "",
    ...(contribution.change === "update" ? ["(This contribution is a unified diff of changes to the source this entry was written from: apply those changes to the entry and keep everything else as it is.)", ""] : []),
    contribution.body,
    existingMarkdown ? `\nEXISTING ENTRY (${entryId}):\n${hideSourceProperties(existingMarkdown)}` : "",
    `\nCONTRIBUTION DATE: ${originDate ?? contribution.sourceUpdated ?? now().slice(0, 10)}`,
    ...(previous ? [`CONTEXT: ORIGIN DATE ${originDate ?? "unknown"}; ENTRY UPDATED ${entryUpdated ?? "unknown"}; CONTRIBUTION IS OLDER THAN THE ENTRY: ${contributionIsOlder ? "yes" : "no"}`] : []),
    ...(input.updateInPlace ? ["UPDATE IN PLACE: yes (this contribution restates a claim the entry already holds, with new figures)"] : []),
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
    return LlmOpinion.parse({ ...o, summary, properties: dropSourceProps(stripProperties(o.properties)), detail });
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
  // Older contribution: the code, not the model, guarantees existing facts are untouched. If the body changed
  // outside History, discard it, keep the old body and append only the new History lines.
  let olderGuard: ProduceEntryResult["olderGuard"];
  if (contributionIsOlder && previous && !(entryId && isDecisionMarkdown(previous))) {
    const prevBody = parseFrontmatter(previous).body;
    const prevMain = detailMainLines(prevBody);
    const newMain = detailMainLines(opinion.detail);
    const prevSet = new Set(prevMain);
    const newSet = new Set(newMain);
    // prevMain holds the H1 and lede, which detail does not: ignore lines the detail never carried.
    const added = newMain.some((l) => !prevSet.has(l));
    const dropped = prevMain.some((l, i) => i > 1 && !l.startsWith("# ") && !newSet.has(l));
    if (added || dropped) {
      const mainText = splitHistory(prevBody).main;
      const oldDetail = mainText.replace(/^\s*# .*\n+/, "").replace(/^[^\n]*\S[^\n]*(\n|$)/, "").trim();
      const have = new Set(historyLines(previous).map((l) => l.replace(/\s+/g, " ").trim()));
      const fresh = historyLines(`---\n---\n${opinion.detail}`).filter((l) => !have.has(l.replace(/\s+/g, " ").trim()));
      const history = [...historyLines(previous), ...fresh];
      opinion = LlmOpinion.parse({ ...opinion, detail: `${oldDetail}${history.length ? `\n\n## History\n\n${history.join("\n")}` : ""}` });
      olderGuard = { discarded: true, historyAdded: fresh };
      console.warn(`produce: contribution ${originDate} is older than entry ${entryUpdated}; model changed the body, kept the old body and added ${fresh.length} History line(s)`);
    }
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
  const resolveLinks = input.resolveLinks;
  const delivered = [...(previous && mergeId ? deliveredBullets(previous) : []), ...deliveredBullets(contribution.body)]
    .map((b) => (resolveLinks ? { ...b, links: resolveLinks(b.links) } : b));
  if (!(decisionTarget && !supersedes)) {
    let detail = delivered.length ? mergeDelivered(opinion.detail, delivered) : opinion.detail;
    // Links the model copied from the old entry may name retired entries too.
    if (resolveLinks) detail = mapDeliveredLinks(detail, resolveLinks);
    if (detail !== opinion.detail) opinion = LlmOpinion.parse({ ...opinion, detail });
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
  const contentText = entryHashText(opinion.title, opinion.summary, opinion.detail);
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
  return { entry, action, historyRestored, lint, overflow, deduped, ...(olderGuard ? { olderGuard } : {}) };
}


// verbatim produce (no LLM) lives in produce-verbatim.ts
export { produceVerbatim, verbatimParts } from "./produce-verbatim.js";
