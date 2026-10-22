/**
 * produce — the ONE generative LLM call (smart model). Writes/rewrites the
 * curated entry. On merge, feed it only the delta + the existing entry so the
 * call stays bounded and cheap (don't re-generate unchanged prose).
 */
import type { Engine } from "@wolfpack/engine";
import { parseFrontmatter, PRODUCE_SYSTEM, PRODUCE_HISTORY_RULES, GRADUATE_FEATURE_RULES, GRADUATE_HUB_RULES } from "@wolfpack/engine";
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
  type Relation,
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
import { existingRelations, foldIntro, normalizeDetail, preserveHistory } from "./preserve.js";

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
  /** Id to give a NEW entry (instead of a random one), e.g. a graduation's own entry */
  newEntryId?: string;
  /** Extra prompt context (e.g. recorded feature entries for a hub). */
  context?: string;
  /** Existing entry markdown for merge context */
  existingMarkdown?: string;
  /** The entry being replaced when it is not fed to the model (a graduation
   *  regenerated from its dossier): its History lines and relations are kept. */
  previousMarkdown?: string;
  /** Merge style of the domain: `history` keeps dated snapshots (default `current`). */
  style?: "history" | "current";
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
  /** Knowledge-lint outcome on the model's output (absent for graduations). */
  lint?: { retried: boolean; before: LintFinding[]; after: LintFinding[] };
}

/**
 * Lint what the model wrote, ignoring lines the entry already carried (a merge
 * keeps old History lines verbatim, so their content is not the model's fault).
 */
export function lintOpinion(o: LlmOpinion, previous: string | undefined, style: string | undefined): LintFinding[] {
  const old = new Set((previous ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
  const body = o.detail.split("\n").filter((l) => !old.has(l.trim())).join("\n");
  // Content checks look at what is new; size counts the whole entry the reader gets.
  const fresh = lintKnowledge({ title: o.title, summary: o.summary, body, properties: o.properties, style, cap: Infinity });
  const size = lintKnowledge({ body: o.detail, style, extraChars: o.summary.length }).filter((f) => f.code === "oversize");
  return [...fresh, ...size];
}

/** True when the entry markdown declares `kind: decision`. */
export function isDecisionMarkdown(markdown: string): boolean {
  return parseFrontmatter(markdown).fields.kind === "decision";
}

/** Work item ids never reach the KB (the Factory is not linked from it). */
const WORK_ID = /\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/g;

/**
 * Code-side guard for graduated entries: strip any work id the model let
 * through, and make an initiative hub always an overview.
 */
export function scrubGraduation(opinion: LlmOpinion, graduation: "feature" | "hub"): LlmOpinion {
  const strip = (t: string) => t.replace(WORK_ID, "").replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
  return LlmOpinion.parse({
    ...opinion,
    title: strip(opinion.title).trim(),
    summary: strip(opinion.summary).trim(),
    detail: strip(opinion.detail),
    ...(graduation === "hub" ? { kind: { type: "overview" } } : {}),
  });
}

/**
 * Verbatim-opinion builder: construct an LlmOpinion from the contribution body
 * without calling the LLM. Title = first H1 (`# ...`) in the body; summary =
 * first non-empty, non-H1 paragraph; detail = body as written (H1 stripped).
 *
 * Used when `preserveBody` is set — the sender's deliberate account IS the
 * entry. Classification + relations are still handled by the normal pipeline.
 */
export function buildVerbatimOpinion(c: Pick<ParsedContribution, "body" | "summary">): LlmOpinion {
  const body = c.body ?? "";
  const h1Match = body.match(/^#\s+([^\n]+)\n/);
  const title = h1Match ? h1Match[1].trim() : (c.summary.split("\n")[0] || "Untitled").trim();
  const detail = (h1Match ? body.slice(h1Match[0].length) : body).trim();
  // Summary resolution order:
  //   1. Sender's deliberate one-line summary (no newlines, not just an H1).
  //   2. First non-empty, non-header paragraph of the detail (strips tables
  //      and headings; useful when the sender just wrote prose).
  //   3. Fallback to the title.
  // Flattened to a single line and clipped at 200 chars.
  const senderSummary = (c.summary ?? "").trim();
  const senderSummaryIsClean =
    senderSummary &&
    !senderSummary.includes("\n") &&
    !senderSummary.startsWith("#");
  const bodyParagraph = detail
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("|"));
  const summaryRaw =
    (senderSummaryIsClean && senderSummary) ||
    bodyParagraph ||
    senderSummary ||
    title;
  const summaryLine = summaryRaw.replace(/\s+/g, " ").trim();
  const summary = summaryLine.length > 200 ? summaryLine.slice(0, 197) + "…" : summaryLine;
  return LlmOpinion.parse({
    title,
    summary,
    detail,
    kind: { type: "fact" },
    confidence: "verified",
    facets: {},
    properties: {},
    proposedRelations: [],
  });
}

/** The part_of edge a graduated feature carries to its initiative's hub. */
export function graduationRelations(c: Pick<ParsedContribution, "graduation" | "partOf">): Relation[] {
  if (c.graduation !== "feature" || !c.partOf) return [];
  const target = EntryId.safeParse(c.partOf);
  return target.success ? [{ kind: "part_of", target: target.data, source: "code", weight: 1 }] : [];
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
  const { contribution, domain, section, placement, entryId, newEntryId, existingMarkdown, previousMarkdown, style, existingCreated, resolve, overrides, context } = input;
  const previous = existingMarkdown ?? previousMarkdown;
  const graduation = contribution.graduation;
  const action: ProduceEntryResult["action"] = entryId ? "merge" : "create";

  // Preserve-body shortcut: for deliberate accounts (graduated features by
  // default), the sender's body IS the record. Skip the LLM entirely and
  // derive title/summary deterministically. Hubs never take this path — they
  // are LLM-produced short overviews. Classification + relations still run
  // through the normal post-LLM pipeline.
  let opinion: LlmOpinion;
  let lint: ProduceEntryResult["lint"];
  if (contribution.preserveBody && graduation !== "hub") {
    opinion = buildVerbatimOpinion(contribution);
  } else {
    // Build LLM prompt (bounded, context-aware)
    const prompt = [
      `DOMAIN: ${domain}`,
      `CONTRIBUTION (from ${contribution.from}):`,
      contribution.summary,
      "",
      contribution.body,
      existingMarkdown ? `\nEXISTING ENTRY (${entryId}):\n${existingMarkdown}` : "",
      context ? `\n${context}` : "",
      graduation === "hub" && contribution.final ? "\nTHE INITIATIVE IS COMPLETE." : "",
      `\nCONTRIBUTION DATE: ${contribution.sourceUpdated ?? now().slice(0, 10)}`,
      `ACTION: ${action}`,
    ].join("\n");

    // LLM call — returns ONLY opinion (no ids, dates, section, resolved relations).
    // Re-parse through the schema to guarantee branded types AND re-validate the
    // model output (the confinement firewall — nothing invalid reaches assemble).
    const system = [
      PRODUCE_SYSTEM,
      style === "history" ? PRODUCE_HISTORY_RULES : "",
      graduation ? (graduation === "hub" ? GRADUATE_HUB_RULES : GRADUATE_FEATURE_RULES) : "",
    ].filter(Boolean).join("\n\n");
    const shape = (raw: unknown): LlmOpinion => {
      let o = LlmOpinion.parse(raw);
      if (graduation) o = scrubGraduation(o, graduation);
      // The entry renders as H1 + lede + detail: the detail must not repeat them.
      const detail = normalizeDetail(o.detail, o.summary, previous);
      return LlmOpinion.parse({ ...o, ...foldIntro(o.summary, detail, previous) });
    };
    opinion = shape(await engine.call("produce", LlmOpinion, { system, prompt }));

    // Last line of defence against changelog content: lint, ONE retry with the
    // findings, then strip what can be stripped safely. Graduations are
    // deliberate records of work and are not linted.
    if (!graduation) {
      const before = lintOpinion(opinion, previous, style);
      let retried = false;
      if (hardFindings(before).length || before.some((f) => f.code === "oversize")) {
        retried = true;
        const again = shape(
          await engine.call("produce", LlmOpinion, {
            system,
            prompt: `${prompt}\n\nYOUR PREVIOUS ANSWER FAILED THESE CHECKS:\n${describeFindings(before)}\nWrite the entry again and fix every one. If the body is over the size cap, cut redundancy and anything off the entry's subject (never drop History lines). Commit hashes, task ids, test counts, deploy status and dated headings are never part of an entry; History lines carry dates and reasons only.`,
          })
        );
        opinion = again;
      }
      opinion = LlmOpinion.parse({
        ...opinion,
        properties: stripProperties(opinion.properties),
        detail: stripLedeRepeat(opinion.summary, stripDetailHeading(opinion.detail)),
      });
      lint = { retried, before, after: lintOpinion(opinion, previous, style) };
    }
  }

  // Build DerivedFacts deterministically
  // A decision is never rewritten in place: a contradicting contribution
  // becomes a NEW decision that supersedes it, an agreeing one changes nothing.
  const decisionTarget = !!(entryId && !graduation && existingMarkdown && isDecisionMarkdown(existingMarkdown));
  const supersedes = decisionTarget && opinion.supersedesDecision ? EntryId.parse(entryId) : undefined;
  const mergeId = supersedes ? undefined : entryId;
  const id = EntryId.parse(mergeId ?? newEntryId ?? mkEntryId(domain));
  const timestamp = IsoDate.parse(now().slice(0, 10));
  // On merge the entry keeps its original creation date.
  const kept = IsoDate.safeParse(
    existingCreated ?? (previous ? String(parseFrontmatter(previous).fields.created ?? "") : "")
  );
  const created = mergeId && kept.success ? kept.data : timestamp;

  // Code-side guard: History lines are never lost on an update (a merge, or a
  // graduation regenerated from its dossier).
  let historyRestored: string[] = [];
  if (mergeId && previous && !(decisionTarget && !supersedes)) {
    const kept = preserveHistory(previous, opinion.detail);
    historyRestored = kept.restored;
    if (kept.restored.length) opinion = LlmOpinion.parse({ ...opinion, detail: kept.detail });
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
    // Structural links the sender named (a graduated feature → its hub). Code
    // writes them; the hub's id is fixed, so it may not exist yet.
    relations: [
      // An update keeps the entry's existing links (the model never sees them).
      ...(mergeId && previous ? existingRelations(previous) : []),
      ...graduationRelations(contribution),
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
