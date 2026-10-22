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
import { atomicWrite, DISTILL_SYSTEM, LlmInfraError, type Engine } from "@wolfpack/engine";
import { isTrivialChange, isTrivialRepromote, tryEmitDelta } from "@wolfpack/kb/client";
import {
  contentHash,
  describeFindings,
  hardFindings,
  lintKnowledge,
  readDomainRegistry,
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
      })
    )
    .min(1)
    .max(4),
});

export interface DistilledContribution {
  /** Den topic id this contribution is emitted under. */
  id: string;
  slug: string;
  title: string;
  summary: string;
  /** Exactly the body emitted (starts with the "# title" line). */
  body: string;
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
  /** Domain merge style; `history` domains are exempt from the size cap. */
  style?: string;
}

export interface DistillResult {
  outputs: DistilledContribution[];
  retried: boolean;
  /** Lint findings of the first answer / of what is emitted. */
  before: LintFinding[];
  after: LintFinding[];
  /** Hard finding codes still present: the topic must be held back. */
  heldCodes: string[];
}

function buildPrompt(input: DistillInput, failures?: LintFinding[]): string {
  const prev = input.previous?.length
    ? `PREVIOUS CONTRIBUTIONS (slug: title):\n${input.previous.map((p) => `- ${p.slug}: ${p.title}`).join("\n")}`
    : "PREVIOUS CONTRIBUTIONS: none";
  return [
    `DOMAIN: ${input.domain}`,
    `TOPIC DATE: ${input.date}`,
    `TOPIC TITLE: ${input.title}`,
    `TOPIC SUMMARY: ${input.summary}`,
    prev,
    "",
    "TOPIC BODY:",
    input.body,
    failures?.length ? `\nCHECK FAILURES in your previous answer:\n${describeFindings(failures)}` : "",
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
  const run = async (failures?: LintFinding[]) => {
    const raw = await engine.call("distill", DistillOutputSchema, {
      system: DISTILL_SYSTEM,
      prompt: buildPrompt(input, failures),
    });
    return DistillOutputSchema.parse(raw).contributions;
  };
  const lint = (c: { title: string; summary: string; body: string }) =>
    lintKnowledge({ title: c.title, summary: c.summary, body: cleanBody(c.summary, c.body), style: input.style });

  let contributions = await run();
  const before = contributions.flatMap(lint);
  let retried = false;
  if (hardFindings(before).length || before.some((f) => f.code === "oversize")) {
    retried = true;
    contributions = await run(before);
  }

  // Deterministic strip, ids, title line. Slugs stay unique; the first keeps the topic id.
  const seen = new Set<string>();
  const outputs: DistilledContribution[] = [];
  for (const c of contributions) {
    let slug = c.slug;
    for (let n = 2; seen.has(slug); n++) slug = `${c.slug}-${n}`;
    seen.add(slug);
    outputs.push({
      id: outputs.length === 0 ? input.id : `${input.id}~${slug}`,
      slug,
      title: c.title,
      summary: c.summary,
      body: `# ${c.title}\n\n${cleanBody(c.summary, c.body)}\n`,
    });
  }
  const after = outputs.flatMap(lint);
  const heldCodes = [...new Set(hardFindings(after).map((f) => f.code))];
  return { outputs, retried, before, after, heldCodes };
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
  /** Called for a topic held back by distill: write it back as `promotable: false`. */
  onHold?: (topic: PromoteTopic, reason: string) => void;
  /** Backfill / resend: skip the trivial-change skip and reuse stored outputs when the raw body is unchanged. */
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
  const styles = roots.kbBase ? readDomainRegistry(roots.kbBase) : {};

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
          style: styles[domain]?.style,
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
        },
        (why) => {
          failed = true;
          onProgress?.(`  ${why}`);
        }
      );
      if (emitted) {
        stats.emitted++;
        onProgress?.(`  emitted: ${o.title} → ${domain}${o.id !== topic.id ? ` (${o.id})` : ""}`);
      }
    }
    // A failed write leaves the topic pending; unchanged outputs are fine (hash guard).
    if (failed) stats.pending++;
    else writeDistillRecord(roots, topic.id, record());
  }
  return stats;
}
