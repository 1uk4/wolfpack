/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import { dropSourceProps, hideSourceProperties } from "./source-props.js";
import type { Engine } from "@wolfpack/engine";
import { KB_NO_NOISE, parseFrontmatter, PRODUCE_SYSTEM } from "@wolfpack/engine";
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
  /** YYYY-MM-DD the existing entry's facts were last known true (`factsAsOf:`); derived from existingMarkdown when not given (see factsAsOfOf). */
  entryFactsAsOf?: string;
  /** The alias route found the same claim with new figures: replace the figures in place, add nothing new. */
  updateInPlace?: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}/;

/** Dates a line states about itself: one at line start (a Record line), or in parentheses. A date inside an "Until/by/before …" phrase is a deadline or a past bound, not the line's own date. */
function ownDates(line: string): string[] {
  const out: string[] = [];
  const start = /^\s*(?:[-*]\s+)?(\d{4}-\d{2}-\d{2})\b/.exec(line);
  if (start) out.push(start[1]!);
  for (const m of line.matchAll(/\((\d{4}-\d{2}-\d{2})\)/g)) {
    const before = line.slice(0, m.index).toLowerCase();
    if (/\b(until|by|before)\s*$/.test(before)) continue;
    out.push(m[1]!);
  }
  return out;
}

/**
 * The date a contribution's facts date from, in order: sourceUpdated, groupDate, sourceCreated (graduation sets these from
 * the feature's dates), submitted, and only then dates the text states about its own lines (see ownDates), ignoring any date
 * after `today`.
 */
export function deriveOriginDate(
  c: Pick<ParsedContribution, "summary" | "body" | "sourceUpdated" | "groupDate" | "sourceCreated" | "submitted">,
  today: string = now().slice(0, 10),
): string | undefined {
  for (const d of [c.sourceUpdated, c.groupDate, c.sourceCreated, c.submitted]) {
    const m = ISO.exec(d ?? "");
    if (m) return m[0];
  }
  const dates = `${c.summary ?? ""}\n${c.body ?? ""}`.split("\n").flatMap(ownDates).filter((d) => d <= today).sort();
  return dates[dates.length - 1];
}

/**
 * When the entry's facts were last known true: its `factsAsOf:` field; for entries without it, the newest date in its
 * History lines, else `updated:`. (`updated:` alone is "last touched": History-only merges advance it.)
 */
export function factsAsOfOf(markdown: string): string | undefined {
  const f = parseFrontmatter(markdown).fields;
  const own = ISO.exec(String(f.factsAsOf ?? ""))?.[0];
  if (own) return own;
  const hist = historyLines(markdown).flatMap((l) => [...l.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0])).sort();
  if (hist.length) return hist[hist.length - 1];
  return ISO.exec(String(f.updated ?? ""))?.[0];
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** An entry body as the model sees it: lede (summary) and detail without History, wrapper heading and H1. Same shape for the old body and the model's answer. */
function bodyParts(markdown: string, fallbackSummary: string): { summary: string; main: string; history: string } {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^\s+/, "");
  const { main, history } = splitHistory(body);
  const h1 = /^# [^\n]*\n+/.exec(main);
  if (!h1) return { summary: fallbackSummary, main: stripDetailHeading(main).trim(), history };
  const rest = main.slice(h1[0].length);
  const lede = /^([^\n#][^\n]*(?:\n(?!\s*\n)[^\n]*)*)(?:\n\s*\n|$)/.exec(rest);
  return lede
    ? { summary: lede[1]!, main: stripDetailHeading(rest.slice(lede[0].length)).trim(), history }
    : { summary: fallbackSummary, main: stripDetailHeading(rest).trim(), history };
}

/** The same text apart from line wrapping and spacing. */
const sameText = (a: { summary: string; main: string }, b: { summary: string; main: string }): boolean =>
  squash(`${a.summary}\n${a.main}`) === squash(`${b.summary}\n${b.main}`);


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
  const entryFactsAsOf = input.entryFactsAsOf ?? (previous ? factsAsOfOf(previous) : undefined);
  if (previous && !originDate) console.warn(`produce: no origin date for ${contribution.from}/${contribution.denTopicId}, treating the contribution as newer`);
  const contributionIsOlder = !!(previous && originDate && entryFactsAsOf && originDate < entryFactsAsOf);

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
    ...(previous ? [`CONTEXT: ORIGIN DATE ${originDate ?? "unknown"}; ENTRY FACTS AS OF ${entryFactsAsOf ?? "unknown"}; CONTRIBUTION IS OLDER THAN THE ENTRY: ${contributionIsOlder ? "yes" : "no"}`] : []),
    ...(input.updateInPlace ? ["UPDATE IN PLACE: yes (this contribution restates a claim the entry already holds, with new figures)"] : []),
    `ACTION: ${action}`,
    allowOverflow
      ? `OVERFLOW: allowed${existingMarkdown && splitHistory(parseFrontmatter(existingMarkdown).body).main.length > DEFAULT_BODY_CAP ? " (the EXISTING ENTRY is already over the size cap, so it covers more than one subject. The contribution was routed here: it stays in this entry. The entry's main subject is what most of its existing text and the contribution are about. Move the other, smaller subject of the EXISTING text into overflow, remove it from the entry, and retitle the entry only if its title named the moved subject)" : ""}`
      : "OVERFLOW: not allowed (leave out anything about another subject)",
  ].join("\n");

  // LLM call — returns ONLY opinion (no ids, dates, section, resolved relations).
  // Re-parse through the schema to guarantee branded types AND re-validate the
  // model output (the confinement firewall — nothing invalid reaches assemble).
  let rawSummary = "";
  const shape = (raw: unknown): LlmOpinion => {
    const o = LlmOpinion.parse(raw);
    rawSummary = o.summary; // before foldIntro moves prose into it: the stand-in lede of an entry that has none
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
        prompt: `${prompt}\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS:\n${describeFindings(before)}\nWrite the entry again and fix every one. If the body is over the size cap${allowOverflow ? ", put material about a second subject in `overflow` (its own title, summary and detail) and otherwise" : ","} cut redundancy and anything off the entry's subject (never drop History lines). Never write ${KB_NO_NOISE}, or dated headings, in an entry; a work id appears only as the closing citation of a History line; History lines carry dates and reasons only. A [[link]] names a real entry id only: write anything else as plain words.`,
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
  // Runs only here, in produceEntry: the verbatim path (produce-verbatim.ts) makes no model call and never reaches it, and a
  // decision entry is never rewritten in place (it has its own supersede flow).
  let olderGuard: ProduceEntryResult["olderGuard"];
  const guardable = !!(previous && entryId && !isDecisionMarkdown(previous));
  const modelMain = (): { summary: string; main: string } => ({ summary: opinion.summary, main: stripDetailHeading(splitHistory(opinion.detail).main).trim() });
  if (contributionIsOlder && guardable && previous) {
    const old = bodyParts(previous, rawSummary);
    // Same shape on both sides; a rewrap alone is not a change, a changed figure is.
    if (!sameText(old, modelMain())) {
      // Only History lines the entry does not already carry; the incoming fact is the older one, so its "Until" is the date the entry's facts were last known true.
      const seenNew = new Set<string>();
      const fresh = splitHistory(opinion.detail).history.split("\n")
        .filter((l) => l.trim().startsWith("- ") && !keepHistory.has(squash(l)))
        .map((l) => l.trim().replace(/^- Until \d{4}-\d{2}-\d{2}/, `- Until ${entryFactsAsOf}`))
        .filter((l) => !seenNew.has(squash(l)) && seenNew.add(squash(l)));
      let detail = `${old.main}\n\n## History\n\n${fresh.join("\n")}`.trim();
      detail = preserveHistory(previous, detail).detail;
      detail = dedupeDetail(detail, keepHistory).detail;
      const added = historyLines(`---\n---\n${detail}`).filter((l) => !keepHistory.has(squash(l)));
      opinion = LlmOpinion.parse({ ...opinion, summary: old.summary, detail });
      // Lint what the guarded result carries, so the reported findings match what is committed.
      after = lintOpinion(opinion, previous, liveIds);
      olderGuard = { discarded: true, historyAdded: added };
      console.warn(`produce: contribution ${originDate} is older than the entry's facts (${entryFactsAsOf}); the model changed the body, kept the old body and added ${added.length} History line(s)`);
    }
  }
  // Update in place restates a claim with new figures: the entry must not grow.
  if (input.updateInPlace && guardable && previous && !olderGuard) {
    const old = bodyParts(previous, rawSummary);
    const cur = modelMain();
    const len = (p: { summary: string; main: string }): number => squash(`${p.summary}\n${p.main}`).length;
    const lines = (p: { main: string }): number => p.main.split("\n").filter((l) => l.trim()).length;
    if (len(cur) > len(old) * 1.1 || lines(cur) > lines(old) * 1.1) {
      opinion = LlmOpinion.parse({ ...opinion, summary: old.summary, detail: `${old.main}${old.history.trim() ? `\n\n${old.history.trim()}` : ""}` });
      after = lintOpinion(opinion, previous, liveIds);
      console.warn(`produce: update-in-place grew the entry by more than 10%, kept the old body`);
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
    // Facts last known true: advances only when the body outside History really changed and the guard did not discard it.
    factsAsOf: (() => {
      const prior = entryFactsAsOf;
      const changed = !previous || !mergeId || !sameText(bodyParts(previous, rawSummary), { summary: opinion.summary, main: stripDetailHeading(splitHistory(opinion.detail).main).trim() });
      const next = changed && !olderGuard ? (originDate ?? timestamp) : prior;
      const best = next && prior && prior > next ? prior : next;
      return best ? IsoDate.parse(best) : undefined;
    })(),
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
