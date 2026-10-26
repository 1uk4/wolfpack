/**
 * Distill — what reaches the KB is durable knowledge; the den stays working
 * memory.
 *
 * A den topic may carry status, task ids, commit hashes, test counts and
 * deploy notes. At promote, each changed topic is converted by ONE engine step
 * (`distill`, DISTILL_SYSTEM) into 1-4 contributions, linted, retried once,
 * stripped of what can be stripped safely, and only then emitted. A topic whose
 * distilled text still carries changelog junk is held back, not emitted.
 *
 * Ids: the first contribution keeps the den topic id; extras get
 * `<topicId>~<slug>`. The slugs of earlier promotes are fed back to the model,
 * so a split keeps stable ids (and so stable KB aliases) across promotes.
 *
 * State (den-local `<den>/kb/distill/<id>.json`, never synced): the RAW body
 * last handled, the distilled outputs (also for debugging), every slug emitted
 * and, when held, the reason. The trivial-change skip compares RAW bodies, so an
 * unchanged topic costs no LLM call.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, DISTILL_SYSTEM, DISTILL_GRADUATION, DISTILL_GRADUATION_STANDING, LlmInfraError, type Engine } from "@wolfpack/engine";
import { isTrivialChange, isTrivialRepromote, nearestEntries, tryEmitDelta } from "@wolfpack/kb/client";
import {
  contentHash,
  describeFindings,
  hashTag,
  hardFindings,
  lintKnowledge,
  safeSegment,
  stripDetailHeading,
  stripLedeRepeat,
  type KbRoots,
  type LintFinding,
} from "@wolfpack/kb/shared";

// ── schema ───────────────────────────────────────────────────────────────────

const toSlug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export const DistillOutputSchema = z.object({
  contributions: z
    .array(
      z.object({
        slug: z.string().transform(toSlug).refine((s) => s.length > 0, "slug is empty"),
        title: z.string().min(3).max(140),
        summary: z.string().min(1).transform((s) => s.replace(/\s+/g, " ").trim()),
        body: z.string().min(1),
        /** Graduation only: the one initiative-level contribution. */
        initiative: z.boolean().optional(),
        /** Standing-feature graduation: the one contribution whose summary describes the feature itself. */
        feature: z.boolean().optional(),
        /** An id from EXISTING ENTRIES: the entry this contribution is about. */
        target: z.string().optional(),
      })
    )
    .min(1)
    .max(5),
});

export interface DistilledContribution {
  /** Den topic id this contribution is emitted under. */
  id: string;
  slug: string;
  title: string;
  summary: string;
  /** Exactly the body emitted (starts with the "# title" line). */
  body: string;
  /** Graduation: the initiative-level contribution (emitted under the initiative's topic id). */
  initiative?: boolean;
  /** Standing-feature graduation: the feature's own contribution (emitted under the item's id; only its summary is the model's). */
  feature?: boolean;
  /** The existing entry this contribution is about (always one of the offered ones). */
  target?: string;
}

export interface DistillRecord {
  rawHash: string;
  rawBody: string;
  at: string;
  /** Every slug ever emitted for this topic, main subject first. */
  slugs: Array<{ slug: string; title: string }>;
  outputs: DistilledContribution[];
  /** Set when the topic was held back: the lint codes. */
  held?: string;
}

// ── state ────────────────────────────────────────────────────────────────────

const recordPath = (roots: KbRoots, id: string) => join(roots.denLocal, "distill", `${safeSegment(id, "den topic id")}.json`);

export function readDistillRecord(roots: KbRoots, id: string): DistillRecord | null {
  try {
    const p = recordPath(roots, id);
    if (!existsSync(p)) return null;
    const r = JSON.parse(readFileSync(p, "utf-8")) as DistillRecord;
    return r && typeof r.rawBody === "string" && Array.isArray(r.outputs) ? r : null;
  } catch {
    return null;
  }
}

function writeDistillRecord(roots: KbRoots, id: string, rec: DistillRecord): void {
  mkdirSync(join(roots.denLocal, "distill"), { recursive: true });
  atomicWrite(recordPath(roots, id), JSON.stringify(rec, null, 2) + "\n");
}

// ── the distill step ─────────────────────────────────────────────────────────

export interface DistillInput {
  id: string;
  title: string;
  summary: string;
  body: string;
  domain: string;
  /** Slugs of earlier promotes (stable identity of a split). */
  previous?: Array<{ slug: string; title: string }>;
  /** YYYY-MM-DD used for History lines the topic does not date. */
  date: string;
  /** The entries of the domain nearest to this input (see nearestEntries), shown to the model. */
  existing?: Array<{ id: string; title: string; summary: string }>;
  /**
   * Set when the input is a finished work item (DISTILL_GRADUATION is added to
   * the prompt): its History lines cite `workId`, an initiative contribution is
   * emitted under `initiativeTopicId`, and every Totals value must survive.
   */
  graduation?: {
    workId: string;
    initiativeTopicId?: string;
    /** The initiative's title: a contribution with this title (or slug "initiative") is the initiative's even if the model forgot the flag. */
    initiativeTitle?: string;
    totals?: Array<{ key: string; value: string }>;
    /** The graduating item IS the initiative: keep only its initiative contribution. */
    only?: "initiative";
    /** The item is a feature of a standing initiative: it keeps its own entry (code writes its body), the model supplies its summary. */
    standingFeature?: { title: string };
  };
}

export interface DistillResult {
  outputs: DistilledContribution[];
  retried: boolean;
  /** Lint findings of the first answer / of what is emitted. */
  before: LintFinding[];
  after: LintFinding[];
  /** Hard finding codes still present: the topic must be held back. */
  heldCodes: string[];
  /** Graduation: Totals values (`Key: value`) still missing after the retry. */
  missingTotals: string[];
  /** Graduation: non-blocking problems for the preview (no History line, no initiative entry…). */
  warnings: string[];
}

function buildPrompt(input: DistillInput, failures?: LintFinding[], missing: string[] = [], noInitiative = false, noFeature = false): string {
  const failureLines = [
    failures?.length ? describeFindings(failures) : "",
    missing.length
      ? `- totals: these Totals values are missing or changed; each must appear unchanged (digits and unit) in the body or History: ${missing.join("; ")}`
      : "",
    noInitiative
      ? '- initiative: the INITIATIVE contribution is missing; add exactly one more contribution with "initiative": true and slug "initiative"'
      : "",
    noFeature
      ? '- feature: the FEATURE contribution is missing; add exactly one more contribution with "feature": true and slug "feature"'
      : "",
  ].filter(Boolean);
  const prev = input.previous?.length
    ? `PREVIOUS CONTRIBUTIONS (slug: title):\n${input.previous.map((p) => `- ${p.slug}: ${p.title}`).join("\n")}`
    : "PREVIOUS CONTRIBUTIONS: none";
  return [
    `DOMAIN: ${input.domain}`,
    `TOPIC DATE: ${input.date}`,
    `TOPIC TITLE: ${input.title}`,
    `TOPIC SUMMARY: ${input.summary}`,
    prev,
    input.existing?.length
      ? `EXISTING ENTRIES (id: title — summary):\n${input.existing.map((e) => `- ${e.id}: ${e.title} — ${e.summary.replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}`
      : "EXISTING ENTRIES: none",
    "",
    "TOPIC BODY:",
    input.body,
    failureLines.length ? `\nCHECK FAILURES in your previous answer:\n${failureLines.join("\n")}` : "",
  ].join("\n");
}

/** Body of a model contribution, normalized: no title line, no Detail wrapper, no repeated lede. */
function cleanBody(summary: string, body: string): string {
  const noTitle = body.replace(/^\s*# [^\n]*\n+/, "");
  return stripLedeRepeat(summary, stripDetailHeading(noTitle)).trim();
}

/**
 * Distill one topic. Throws when the model call fails (the caller leaves the
 * topic pending); never returns junk: hard findings after the single retry are
 * reported in `heldCodes`.
 */
export async function distillTopic(engine: Engine, input: DistillInput): Promise<DistillResult> {
  const grad = input.graduation;
  const standing = grad?.standingFeature;
  const system = grad ? `${DISTILL_SYSTEM}\n\n${DISTILL_GRADUATION}${standing ? `\n\n${DISTILL_GRADUATION_STANDING}` : ""}` : DISTILL_SYSTEM;
  const run = async (failures?: LintFinding[], missing: string[] = [], noInitiative = false, noFeature = false) => {
    const raw = await engine.call("distill", DistillOutputSchema, {
      system,
      prompt: buildPrompt(input, failures, missing, noInitiative, noFeature),
    });
    const all = DistillOutputSchema.parse(raw).contributions;
    return grad ? all : all.slice(0, 4).map((c) => ({ ...c, initiative: undefined, feature: undefined }));
  };
  /** The standing feature's contribution: flagged, or slugged "feature". */
  const isFeature = (c: { slug: string; feature?: boolean }) => !!standing && (c.feature === true || c.slug === "feature");
  // The feature's body is replaced by code, so only its summary is linted.
  const lint = (c: { slug: string; title: string; summary: string; body: string; feature?: boolean }) =>
    isFeature(c) ? lintKnowledge({ title: c.title, summary: c.summary, body: "-", workIds: "history" }) : lintKnowledge({ title: c.title, summary: c.summary, body: cleanBody(c.summary, c.body), workIds: grad ? "history" : "none" });
  // (a standing feature's totals are in the body code writes, not in the model's text)
  const missingOf = (cs: Array<{ title: string; summary: string; body: string }>) =>
    grad?.totals?.length && !standing ? missingTotals(grad.totals, cs.map((c) => `${c.summary}\n${c.body}`).join("\n")) : [];
  const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  /** The initiative's contribution: flagged, or slugged "initiative", or titled like the initiative. */
  const isInitiative = (c: { slug: string; title: string; initiative?: boolean }) =>
    !!grad?.initiativeTopicId && (c.initiative === true || c.slug === "initiative" || (!!grad.initiativeTitle && normTitle(c.title) === normTitle(grad.initiativeTitle)));
  const missingInitiative = (cs: Array<{ slug: string; title: string; initiative?: boolean }>) =>
    !!grad?.initiativeTopicId && grad.only !== "initiative" && !cs.some(isInitiative);

  const missingFeature = (cs: Array<{ slug: string; feature?: boolean }>) => !!standing && !cs.some(isFeature);

  let contributions = await run();
  const before = contributions.flatMap(lint);
  let missing = missingOf(contributions);
  let retried = false;
  if (hardFindings(before).length || before.some((f) => f.code === "oversize") || missing.length || missingInitiative(contributions) || missingFeature(contributions)) {
    retried = true;
    contributions = await run(before, missing, missingInitiative(contributions), missingFeature(contributions));
    missing = missingOf(contributions);
  }

  // Deterministic strip, ids, title line. Slugs stay unique; the first keeps the topic id.
  const seen = new Set<string>();
  const outputs: DistilledContribution[] = [];
  const warnings: string[] = [];
  // With a standing feature, the topic id belongs to the feature's contribution.
  let plain = standing ? 1 : 0;
  let featureSeen = false;
  for (const c of contributions) {
    if (grad?.only === "initiative" && outputs.length) {
      warnings.push(`dropped an extra contribution: "${c.title}"`);
      continue;
    }
    const isFeat = isFeature(c) && !featureSeen;
    if (isFeat) featureSeen = true;
    const isInit = !isFeat && !!(grad?.initiativeTopicId && (isInitiative(c) || grad.only === "initiative") && !outputs.some((o) => o.initiative));
    let slug = c.slug;
    for (let n = 2; seen.has(slug); n++) slug = `${c.slug}-${n}`;
    seen.add(slug);
    let body = cleanBody(c.summary, c.body);
    if (grad && !isFeat) body = citeWork(body, grad.workId);
    const title = isFeat ? standing!.title : c.title;
    outputs.push({
      id: isInit ? grad!.initiativeTopicId! : isFeat ? input.id : plain++ === 0 ? input.id : `${input.id}~${slug}`,
      slug,
      title,
      summary: c.summary,
      body: `# ${title}\n\n${body}\n`,
      ...(isInit ? { initiative: true } : {}),
      ...(isFeat ? { feature: true } : {}),
      // Confinement: only an offered entry can be a target; the initiative is anchored, never targeted.
      ...(!isInit && !isFeat && c.target?.trim() && input.existing?.some((e) => e.id === c.target?.trim()) ? { target: c.target.trim() } : {}),
    });
  }
  if (grad) {
    for (const o of outputs) if (!o.feature && !/^## History[ \t]*$/m.test(o.body)) warnings.push(`"${o.title}" has no History line citing the work`);
    if (grad.initiativeTopicId && !outputs.some((o) => o.initiative)) warnings.push("no initiative entry was produced");
    if (grad.only !== "initiative" && !outputs.some((o) => !o.initiative)) warnings.push("only an initiative entry was produced");
    if (standing && !featureSeen) warnings.push("no summary of the feature was produced");
  }
  const after = outputs.flatMap((o) => lintKnowledge({ title: o.title, summary: o.summary, body: o.feature ? "-" : o.body.replace(/^# [^\n]*\n+/, ""), workIds: grad ? "history" : "none" }));
  const heldCodes = [...new Set(hardFindings(after).map((f) => f.code))];
  return { outputs, retried, before, after, heldCodes, missingTotals: missing, warnings };
}

const WORK_ID_ANY = /\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/g;

/**
 * Totals values (`Key: value`) that do not appear unchanged in `text`: the
 * value's digits and unit, not part of a longer number.
 */
export function missingTotals(totals: Array<{ key: string; value: string }>, text: string): string[] {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return totals
    .filter((t) => !new RegExp(`(?<![\\d.,:])${esc(t.value)}(?![\\d]|[.,]\\d|:\\d)`, "i").test(text))
    .map((t) => `${t.key}: ${t.value}`);
}

/**
 * Graduation History lines cite the work: any History line without the work id
 * gets it appended, and any other work id is dropped (code, not trust).
 */
function citeWork(body: string, workId: string): string {
  const at = body.search(/^## History[ \t]*$/m);
  const strip = (t: string) => t.replace(WORK_ID_ANY, (m) => (m === workId ? m : "")).replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
  if (at < 0) return strip(body);
  const head = strip(body.slice(0, at));
  const lines = body.slice(at).split("\n").map((l) => {
    if (!/^\s*- /.test(l)) return strip(l);
    const t = strip(l).trimEnd();
    return t.includes(workId) ? t : `${t} (${workId})`;
  });
  return head + lines.join("\n");
}

/**
 * The domain's entries nearest to the input (lexical, over INDEX.md; no
 * embedder needed on a wolf). Never throws: without a mirror there are none.
 */
export function existingFor(roots: KbRoots, domain: string, input: { title: string; summary: string }) {
  try {
    return nearestEntries(roots, domain, `${input.title}\n${input.summary}`, 6).map(({ id, title, summary }) => ({ id, title, summary }));
  } catch {
    return [];
  }
}

// ── promote ──────────────────────────────────────────────────────────────────

export interface PromoteTopic {
  id: string;
  title: string;
  summary: string;
  body: string;
  domain?: string;
  change: "create" | "merge";
}

export interface PromoteOptions {
  engine: Engine;
  roots: KbRoots;
  wolf: string;
  defaultDomain: string;
  session?: string;
  onProgress?: (msg: string) => void;
  /** Called per contribution written to the inbox (id = the inbox file stem). Metadata only. */
  onEmit?: (c: { id: string; denTopicId: string; domain: string }) => void;
  /** Called for a topic held back by distill: write it back as `promotable: false`. */
  onHold?: (topic: PromoteTopic, reason: string) => void;
  /** Backfill / resend: skip the trivial-change skip, reuse stored outputs when the raw body is unchanged, and re-emit bodies already sent (no emitted.json dedup). */
  force?: boolean;
  /** Today (YYYY-MM-DD); tests pin it. */
  today?: string;
}

export interface PromoteStats {
  /** Topics sent through the distill model. */
  distilled: number;
  /** Topics that produced more than one contribution. */
  split: number;
  held: number;
  /** Raw body unchanged since the last promote: no LLM call. */
  trivialSkipped: number;
  /** Distill (or an emit) failed: left pending for the next promote. */
  pending: number;
  /** Contributions written to the inbox. */
  emitted: number;
}

/**
 * Distill and emit a set of den topics. Never throws for one bad topic.
 */
export async function promoteTopics(topics: PromoteTopic[], opts: PromoteOptions): Promise<PromoteStats> {
  const { engine, roots, wolf, defaultDomain, onProgress, force } = opts;
  const stats: PromoteStats = { distilled: 0, split: 0, held: 0, trivialSkipped: 0, pending: 0, emitted: 0 };
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  for (const topic of topics) {
    const domain = topic.domain || defaultDomain;
    const rawHash = contentHash(topic.body);
    const rec = readDistillRecord(roots, topic.id);

    if (!force) {
      // Compare RAW with RAW. A topic from before distill has no record: its
      // last emitted body (the raw one) stands in.
      const same = rec ? isTrivialChange(rec.rawBody, topic.body) : isTrivialRepromote(roots, topic.id, topic.body);
      if (same) {
        stats.trivialSkipped++;
        continue;
      }
    }

    let outputs: DistilledContribution[] = [];
    let slugs = rec?.slugs ?? [];
    let heldCodes: string[] = [];
    if (force && rec && rec.rawHash === rawHash) {
      // Unchanged raw body: reuse what was distilled (or held) before.
      outputs = rec.outputs;
      if (rec.held) heldCodes = rec.held.split(",");
    } else {
      try {
        const r = await distillTopic(engine, {
          id: topic.id,
          title: topic.title,
          summary: topic.summary,
          body: topic.body,
          domain,
          previous: rec?.slugs,
          date: today,
          existing: existingFor(roots, domain, topic),
        });
        stats.distilled++;
        outputs = r.outputs;
        heldCodes = r.heldCodes;
        if (r.outputs.length > 1) stats.split++;
        onProgress?.(
          `  distilled: ${topic.id} ${topic.body.length}→${r.outputs.map((o) => o.body.length).join("+")} chars` +
            `${r.retried ? " (retried)" : ""}${r.after.length ? ` findings: ${[...new Set(r.after.map((f) => f.code))].join(",")}` : ""}`
        );
        for (const o of r.outputs) if (!slugs.some((s) => s.slug === o.slug)) slugs = [...slugs, { slug: o.slug, title: o.title }];
      } catch (err) {
        stats.pending++;
        const infra = err instanceof LlmInfraError || (err instanceof Error && err.cause instanceof LlmInfraError);
        onProgress?.(
          `  distill ${infra ? "unavailable" : "failed"}, topic stays pending: ${topic.id} — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`
        );
        continue;
      }
    }

    const record = (held?: string): DistillRecord => ({ rawHash, rawBody: topic.body, at: new Date().toISOString(), slugs, outputs, ...(held ? { held } : {}) });

    if (heldCodes.length) {
      stats.held++;
      const reason = heldCodes.join(",");
      onProgress?.(`  held back (distill: ${reason}): ${topic.id}`);
      writeDistillRecord(roots, topic.id, record(reason));
      opts.onHold?.(topic, `distill: ${reason}`);
      continue;
    }

    let failed = false;
    for (const o of outputs) {
      const emitted = tryEmitDelta(
        {
          roots,
          wolf,
          denTopicId: o.id,
          change: topic.change,
          domainHint: domain,
          summary: o.summary,
          body: o.body,
          session: opts.session,
          ...(o.target ? { target: o.target } : {}),
          ...(force ? { force: true } : {}),
        },
        (why) => {
          failed = true;
          onProgress?.(`  ${why}`);
        }
      );
      if (emitted) {
        stats.emitted++;
        try {
          opts.onEmit?.({ id: `${emitted.denTopicId}-${hashTag(emitted.contentHash)}`, denTopicId: emitted.denTopicId, domain: emitted.domainHint });
        } catch {
          /* observers never break the promote */
        }
        onProgress?.(`  emitted: ${o.title} → ${domain}${o.id !== topic.id ? ` (${o.id})` : ""}`);
      }
    }
    // A failed write leaves the topic pending; unchanged outputs are fine (hash guard).
    if (failed) stats.pending++;
    else writeDistillRecord(roots, topic.id, record());
  }
  return stats;
}
