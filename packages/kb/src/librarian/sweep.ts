/**
 * sweep — the KB sweep: hierarchical section-tree placement.
 *
 * The one and only KB sweep (v1 retired).
 *
 * First-cut bring-up pipeline (entry-first, reachability never gated):
 *   intake → embed → placeEntry → (classifyToSection fallback) → produceEntry
 *          → commitEntry → record events → renderDomainDigest → persist
 *
 * Tree REORGANIZATION (splitAsParentChild / placeEntry / shouldMerge) runs as a
 * separate maintenance pass and inside the migration backfill, where per-section
 * member vectors are marshaled. It only reorganizes LIVE entries; it never gates
 * reachability. See docs/kb-implementation.md §Phase 5.
 */
import { patchSourceProperties, sourceDiffers, withSourceProperties } from "./source-props.js";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { atomicWrite } from "@wolfpack/engine";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, SWEEP } from "@wolfpack/engine";
import { type KbEvent, type ParsedContribution, ev, now, contentHash } from "../shared/index.js";
import { readLedger, appendLedger, seenHashes, foldRegistry } from "./ledger.js";
import { drainInbox } from "./intake.js";
import { createEmbedder, embedInput, entrySummary, cosine, type Embedder } from "./embed.js";
import { renderRegistry } from "./registry.js";
import { anchorIndex, anchorOf, oldHubFor } from "./anchors.js";
import { syncDelivered } from "./groups.js";
import { type EntryVector } from "./route.js";
import { placeEntry } from "./section-tree.js";
import { computeCentroid, type EntryWithVector as EWV } from "./hierarchy.js";
import { createOracles } from "./oracles.js";
import { resolveAliasedEntry, survivorOf } from "./alias.js";
import { produceEntry, produceVerbatim, type ProduceEntryInput } from "./produce.js";
import { supersededIds } from "./preserve.js";
import { withKbLock, KbLockBusy } from "./lock.js";
import { recoverRebuild } from "./rebuild-commit.js";
import {
  commitEntry,
  readEntryMarkdown,
  writeReceipt,
  markProcessed,
  gitCommit,
  quarantine,
} from "./commit.js";
import { renderDomainIndex, renderDomainDigest, readDeclaredDomains, isDeclared } from "./domains.js";
import { readSections, writeSections } from "./sections.js";
import { withBudget, BudgetExceeded, recordFailure, recordOverrun, clearAttempts, park } from "./park.js";
import { classifyError, shouldParkNow, backoffRemainingMs, noteInfraFailure, noteSweepSuccess, type Alert } from "./backoff.js";
import { writeCurrent, clearCurrent } from "./progress.js";
import { queueWorkLink, workIdOfTopic } from "./work-links.js";
import {
  DomainId,
  EntryId,
  SectionId,
  Slug,
  IsoDate,
  type Section,
  type Placement,
  type RelationResolver,
} from "../schema/knowledge.js";
import type { Engine } from "@wolfpack/engine";
import { entriesDir, type KbRoots } from "../shared/index.js";

/** Structured sweep progress for hosts that surface it (wolfd's event stream). Metadata only. */
export type SweepEvent =
  | { type: "started"; pending: number }
  | { type: "item"; from: string; denTopicId: string; outcome: "create" | "merge" | "reject" | "parked"; entryId?: string };

export interface SweepContext {
  engine: Engine;
  roots: KbRoots;
  /** Load current entry vectors (from cache). Injected for testability. */
  loadEntryVectors: () => Promise<EntryVector[]>;
  /** The tick's embedder, built on first use so a run with nothing to embed
   *  never reads the vector cache (default: a new one). */
  getEmbedder?: () => Embedder;
  notify?: (msg: string) => void;
  /** Messages worth a human's attention (sweep paused/recovered, item parked).
   *  Unlike notify (progress chatter), these are sent to Telegram. */
  alert?: Alert;
  /** Time budget for the run's one contribution (default SWEEP.runBudgetMs).
   *  A test seam: lets tests exercise parking without waiting minutes. */
  budgetMs?: number;
  /** Called when the run starts real work ("started", once) and when a contribution ends in create/merge/reject/parked
   *  ("item"). Never called for an empty inbox. A throwing callback is ignored. */
  onEvent?: (event: SweepEvent) => void;
}

/** One contribution the sweep could not commit, with a human-readable reason. */
export interface SweepFailure {
  from: string;
  denTopicId: string;
  reason: string;
}

export interface SweepResult {
  processed: number;
  created: number;
  merged: number;
  rejected: number;
  errors: number;
  unclassified: number;
  /** Domains where an entry was created or merged (the post-sweep reorg's scope). */
  touchedDomains: string[];
  /** Per-contribution failures (concise reasons), so callers can surface them
   *  instead of leaving them buried in notify() log lines. Still in the inbox. */
  failures: SweepFailure[];
  /** Contributions moved to parked/ this run (over budget or out of attempts). */
  parked: SweepFailure[];
  /** Contributions left in the inbox after this run (await next tick). */
  remaining: number;
  /** Set when the tick did no work because of an outage: skipped inside the
   *  backoff window, or an infrastructure error just started/extended it. */
  paused?: string;
}

/** Turn a thrown error — especially a ZodError — into a short, readable reason.
 *  Raw ZodError messages are multi-line JSON blobs; collapse them to a compact
 *  `path: message` list so a skip is legible at a glance. */
export function cleanError(err: unknown): string {
  const issuesOf = (v: unknown): string | null => {
    const arr = (v as { issues?: unknown })?.issues ?? v;
    if (!Array.isArray(arr)) return null;
    return arr
      .map((i: { path?: unknown[]; message?: string }) =>
        `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`
      )
      .join("; ");
  };
  // ZodError instance, or an Error whose .message is a JSON issues array.
  const direct = issuesOf(err);
  if (direct) return direct.slice(0, 240);
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.trim().startsWith("[")) {
    try {
      const parsed = issuesOf(JSON.parse(msg));
      if (parsed) return parsed.slice(0, 240);
    } catch {
      /* not JSON — fall through */
    }
  }
  return msg.split("\n")[0].slice(0, 240);
}

/** Generate a fresh SectionId: sec-<domain>-<6 alphanumerics>. */
function mkSectionId(domain: string): SectionId {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  // Domain is sanitized to the brand's [a-z0-9-] alphabet by DomainId elsewhere.
  return SectionId.parse(`sec-${domain}-${tail}`);
}

/** The contribution's title: the first H1 of the den topic, else its den topic id. */
export function contributionTitle(c: Pick<ParsedContribution, "body" | "denTopicId">): string {
  const h1 = /^#\s+(.+)$/m.exec(c.body ?? "");
  return (h1?.[1] ?? c.denTopicId.replace(/[-_]+/g, " ")).trim();
}

/** What to do with a contribution that has no alias: from the top-3 scores. */
export type MergeBand =
  | { kind: "create" }
  | { kind: "merge"; id: string }
  | { kind: "ask" };

/**
 * The score band (SWEEP.mergeLow/mergeHigh/mergeMargin): clearly different →
 * create; clearly the same with a clear lead over the runner-up → merge; else
 * ask the LLM. `ranked` is best first.
 */
export function mergeBand(ranked: Array<{ id: string; score: number }>): MergeBand {
  const top = ranked[0];
  if (!top || top.score < SWEEP.mergeLow) return { kind: "create" };
  const lead = top.score - (ranked[1]?.score ?? 0);
  if (top.score >= SWEEP.mergeHigh && lead >= SWEEP.mergeMargin) return { kind: "merge", id: top.id };
  return { kind: "ask" };
}

/** How a contribution was routed; written to its receipt as `routing:` JSON. */
export interface RoutingRecord {
  route: "alias" | "anchor" | "similarity" | "new";
  /** The entry written (set on commit). */
  target?: string;
  /** Top-3 similarity candidates (best first). */
  candidates: Array<{ id: string; score: number }>;
  band?: string;
  subject?: { match: string; valid: boolean; reason?: string };
  /** The near-miss second check (full bodies) that ran before a create. */
  confirm?: { candidate: string; score: number; merge: boolean; valid: boolean; reason?: string };
  /** The entry distill named for this contribution. */
  targetHint?: string;
  domainMismatch?: { hint: string; entry: string };
  warning?: string;
  /** The second subject produce split out, and how it was routed. */
  overflow?: {
    title: string;
    denTopicId: string;
    target?: string;
    action?: string;
    route: string;
    candidates?: Array<{ id: string; score: number }>;
    band?: string;
    subject?: { match: string; valid: boolean; reason?: string };
    confirm?: RoutingRecord["confirm"];
    error?: string;
  };
}

/** Ids of every live entry in every domain (a directory listing). */
export function liveEntryIds(roots: KbRoots): Set<string> {
  const ids = new Set<string>();
  const domains = join(roots.kbBase, "domains");
  if (!existsSync(domains)) return ids;
  for (const d of readdirSync(domains, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = entriesDir(roots, d.name);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) ids.add(f.slice(0, -3));
  }
  return ids;
}

/** `id` if it is a live entry, else the live entry its retirement chain ends at, else null. */
export function liveSurvivor(log: KbEvent[], live: ReadonlySet<string>, id: string): string | null {
  let cur: string | null = id;
  for (let hops = 0; cur && hops < 5; hops++) {
    if (live.has(cur)) return cur;
    cur = survivorOf(log, cur);
  }
  return null;
}

/** The contribution for a second subject split out of `c` (its own den topic id: the alias of `c` stays on the main entry). */
export function overflowContribution(
  c: ParsedContribution,
  o: { title: string; summary: string; body: string },
  domain: string
): ParsedContribution {
  const slug = o.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "overflow";
  const body = `# ${o.title}\n\n${o.summary}\n\n${o.body}`.trim();
  return {
    ...c,
    denTopicId: `${c.denTopicId}~split-${slug}`,
    change: "create",
    contentHash: contentHash(body),
    prevHash: null,
    domainHint: domain,
    summary: o.summary,
    body,
    anchor: undefined,
    target: undefined,
    filePath: join(dirname(c.filePath), `${c.denTopicId}~split-${slug}.md`),
  };
}

/** Put the overflow contribution in the sender's inbox so the next tick routes it as its own item. */
export function requeueOverflow(roots: KbRoots, o: ParsedContribution): void {
  const dir = join(roots.opsRoot, "inbox", o.from);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `from: ${o.from}`,
    `den_topic_id: ${o.denTopicId}`,
    `content_hash: ${o.contentHash}`,
    "prev_hash: null",
    `domain_hint: ${o.domainHint}`,
    ...(o.sourceUpdated ? [`source_updated: ${o.sourceUpdated}`] : []),
    `summary: ${JSON.stringify(o.summary)}`,
    `submitted: ${now()}`,
    "---",
    "",
    o.body,
    "",
  ].join("\n");
  writeFileSync(join(dir, basename(o.filePath)), fm);
}

/** Clamp a routing score into the Placement.fit [0,1] range. Guards against a
 *  cosine FP overshoot (>1) or a reused _unplaced score (<0) hard-failing the
 *  whole contribution at schema-parse time. */
function clampFit(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The KB sweep: hierarchical section-tree placement.
 */
/**
 * Sweep the inbox. Holds the KB write lock; if a reorg/rebuild holds it, this
 * run is skipped (the next tick picks the inbox up).
 */
export async function sweep(ctx: SweepContext): Promise<SweepResult> {
  try {
    return await withKbLock(ctx.roots, () => sweepUnlocked(ctx));
  } catch (err) {
    if (!(err instanceof KbLockBusy)) throw err;
    ctx.notify?.("sweep: skipped, the KB is busy (a reorg or rebuild is running)");
    return emptyResult();
  }
}

export function emptyResult(): SweepResult {
  return {
    processed: 0, created: 0, merged: 0, rejected: 0, errors: 0,
    unclassified: 0, touchedDomains: [], failures: [], parked: [], remaining: 0,
  };
}

async function sweepUnlocked(ctx: SweepContext): Promise<SweepResult> {
  const { engine, roots } = ctx;
  // A rebuild that crashed after its journal is finished first, under the lock (idempotent; a no-op without a journal).
  recoverRebuild(roots);
  const budgetMs = ctx.budgetMs ?? SWEEP.runBudgetMs;

  // One contribution per run, oldest first. The timer fires every minute, so the
  // next one is picked up within a minute. An empty inbox returns here: no
  // embedder, no ledger read, no LLM call, no writes, no log line.
  const pending = drainInbox(roots).sort((a, b) =>
    (a.submitted || "").localeCompare(b.submitted || "")
  );
  if (pending.length === 0) return emptyResult();

  // An outage backoff is in force: skip the tick (the CLI path is a new process
  // each minute, so the state lives in KB_OPS).
  const waitMs = backoffRemainingMs(roots);
  if (waitMs > 0) {
    return { ...emptyResult(), remaining: pending.length, paused: `backing off, ${Math.ceil(waitMs / 1000)}s left` };
  }

  // Already-seen duplicates are retired right away, before the embedder and the
  // vectors load; the first unseen one is this run's contribution. The rest
  // wait for the next tick.
  const log = readLedger(roots);
  const seen = seenHashes(log);
  for (const dup of pending.filter((c) => seen.has(c.contentHash))) markProcessed(dup);
  const unseen = pending.filter((c) => !seen.has(c.contentHash));
  if (unseen.length === 0) return emptyResult();

  const embedder = ctx.getEmbedder?.() ?? createEmbedder(roots);
  let reg = foldRegistry(log); // deterministic identity: (wolf, den topic) -> entry
  // Ollama failing here is an outage, not a bad item: back off instead of throwing.
  let entryVectors: EntryVector[];
  try {
    entryVectors = await ctx.loadEntryVectors();
  } catch (err) {
    if (classifyError(err) !== "infra") throw err;
    const state = await noteInfraFailure(roots, err, ctx.alert);
    ctx.notify?.(`sweep: infrastructure error, backing off (${state.consecutive} in a row): ${cleanError(err)}`);
    return { ...emptyResult(), remaining: unseen.length, paused: state.reason };
  }
  // Section tree, folded from the ledger / _sections.json.
  let sections: Section[] = readSections(roots);

  const batch: KbEvent[] = [];
  const result = emptyResult();

  const declared = readDeclaredDomains(roots);
  const touchedDomains = new Set<string>();

  // ── RELATION RESOLVER (first-cut) ──────────────────────────────────────────
  // Drops all proposed relation hints (returns null) → relations[] starts empty.
  // The soft overlay (embedding see_also + resolved LLM edges) is added in a
  // follow-up; dropping is safe (never invents an id). See §Phase 3b.
  const resolve: RelationResolver = () => null;

  const contributions = unseen.slice(0, 1);
  // Set once the entry is live and its ledger events are written.
  let committed = false;
  result.remaining = unseen.length - contributions.length;
  const emit = (e: SweepEvent) => {
    try {
      ctx.onEvent?.(e);
    } catch {
      /* a bad subscriber never breaks the sweep */
    }
  };
  emit({ type: "started", pending: unseen.length });
  // Item events go out after the persist step, so a subscriber that gets create / merge can read the entry (ledger,
  // registry and git commit are done by then).
  const itemEvents: SweepEvent[] = [];

  // The contribution gets the whole run budget. The merge threshold derives from
  // it: budget * mergeBudgetFraction / msPerMergeChar (600s -> 24,000 chars).
  const itemBudgetMs = budgetMs;
  const maxMergeTargetChars = Math.floor(
    (itemBudgetMs * SWEEP.mergeBudgetFraction) / SWEEP.msPerMergeChar
  );

  for (const c of contributions) {
    result.processed++;

    // One summary line per contribution: route, target size, LLM time, outcome.
    const itemStart = Date.now();
    let route = "?";
    let outcome = "?";
    let llmMs = 0;
    let itemEvent: { outcome: "create" | "merge" | "reject" | "parked"; entryId?: string } | undefined;
    writeCurrent(roots, { from: c.from, denTopicId: c.denTopicId, startedAt: itemStart });
    const setRoute = (r: string) => {
      route = r;
      writeCurrent(roots, { from: c.from, denTopicId: c.denTopicId, startedAt: itemStart, route });
    };

    try {
      await withBudget(itemBudgetMs, async (signal) => {
      // Every LLM call for this contribution is cancelled when its budget ends.
      const itemEngine: Engine = {
        ...engine,
        call: async (step, schema, opts) => {
          const t = Date.now();
          try {
            return await engine.call(step, schema, { ...opts, signal });
          } finally {
            llmMs += Date.now() - t;
          }
        },
      };
      const oracles = createOracles(itemEngine);
      // No domain: park as unclassified rather than guess one.
      if (!c.domainHint) {
        throw Object.assign(new Error("unclassified: contribution has no domain"), {
          parkNow: true,
          parkReason: "unclassified: no domain",
        });
      }
      // May change to the aliased entry's own domain (see below).
      let domain = c.domainHint;
      // How this contribution was routed; written to its receipt.
      const routing: RoutingRecord = { route: "new", candidates: [] };

      // Declared-domain gate — never commit into an unmirrored, unreviewed domain.
      if (!isDeclared(declared, domain)) {
        quarantine(roots, c, domain);
        writeReceipt(roots, c.from, c, "unclassified", `pending domain: ${domain}`);
        markProcessed(c);
        result.unclassified++;
        outcome = `unclassified (domain ${domain})`;
        return;
      }

      // Route, produce and commit ONE contribution (the item itself, or the
      // second subject split out of it). Null: rejected by archive-safety.
      const place = async (c: ParsedContribution, domain0: string, routing: RoutingRecord, overflowOk: boolean, exclude?: string) => {
      let domain = domain0;
      // ── EMBED ───────────────────────────────────────────────────────────
      const title = contributionTitle(c);
      const embedText = embedInput({ title, summary: c.summary, role: "query" });
      const vec = await embedder.embed(embedText, contentHash(embedText));

      // ── IDENTITY (deterministic registry) ───────────────────────────────
      // A re-promote of a known den topic UPDATES its entry (never duplicates).
      // 0) an anchored contribution: by its key; 1) exact alias match (wolf, den topic) from the registry; 2) otherwise
      // the nearest entries by title+summary similarity, with an LLM subject
      // check when the score is uncertain (seeds the alias on commit).
      let targetId: string | undefined;
      // An alias is an explicit routing decision: the entry is looked up in ITS
      // OWN domain, even when the contribution's domain hint differs.
      let aliasedFrom: string | undefined;
      let aliasMissing: string | undefined;
      if (!c.anchor) {
        for (const topic of reg.values()) {
          const alias = topic.aliases.find((a) => a.wolf === c.from && a.denTopicId === c.denTopicId);
          if (!alias) continue;
          aliasedFrom = topic.entries[0];
          const hit = aliasedFrom ? resolveAliasedEntry(roots, log, aliasedFrom, topic.domain || domain) : null;
          if (hit) {
            if (hit.followedFrom) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → alias ${hit.followedFrom} was retired, following it to ${hit.id}`);
            if (hit.domain !== domain) {
              ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → alias ${hit.id} is in domain ${hit.domain}, contribution says ${domain}: merging into the alias`);
              routing.domainMismatch = { hint: domain, entry: hit.domain };
              domain = hit.domain;
            }
            aliasedFrom = hit.id;
          } else {
            aliasMissing = aliasedFrom;
          }
          break;
        }
      }
      // A decision another entry supersedes is history: contributions go to the
      // newest decision in the chain, never to the old one.
      const superseded = supersededIds(roots, domain);
      const head = (id: string): string => {
        for (let i = 0; i < 10 && superseded.has(id); i++) id = superseded.get(id)!;
        return id;
      };
      // Anchored entries are found by their key and kept out of every other
      // contribution's candidates (they share vocabulary with their subjects by
      // construction, so similarity cannot tell them apart).
      const anchors = anchorIndex(roots, domain);
      if (c.anchor) {
        // ANCHORED: by key only, never by alias, similarity or the subject check.
        const held = anchors.byKey.get(c.anchor);
        routing.route = "anchor";
        if (held) {
          targetId = held;
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → ${held} (anchor ${c.anchor})`);
        } else {
          // Old initiative hub: the entry kb-<domain>-<id> the old graduation made
          // for work-<domain>-<id> is adopted, anchored and merged into.
          const hub = oldHubFor(c.anchor, domain);
          const md = hub ? readEntryMarkdown(roots, domain, hub) : null;
          if (hub && md && !anchorOf(md)) {
            targetId = hub;
            ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → ${hub} (old hub adopted, anchor ${c.anchor})`);
          } else {
            ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → new entry (anchor ${c.anchor})`);
          }
        }
      } else {
        if (aliasedFrom && !aliasMissing) {
          targetId = head(aliasedFrom);
          routing.route = "alias";
        } else if (aliasMissing) {
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → new entry, WARNING: aliased entry ${aliasMissing} has no file and no survivor`);
          routing.warning = `aliased entry ${aliasMissing} has no file and no survivor`;
        }
      }
      // The size limit also keeps an oversized entry out of the candidates:
      // the merge rewrites the whole entry.
      const sizeLimit = Number(process.env.KB_MAX_MERGE_TARGET_CHARS) || maxMergeTargetChars;
      if (!targetId && !c.anchor) {
        const ranked: Array<{ id: string; score: number; title: string; summary: string }> = [];
        for (const e of entryVectors) {
          if (e.domain !== domain) continue;
          if (superseded.has(e.entryId)) continue;
          if (anchors.ids.has(e.entryId)) continue;
          if (e.entryId === exclude) continue; // a split never routes back into the entry it came from
          const md = readEntryMarkdown(roots, domain, e.entryId);
          if (!md || md.length > sizeLimit) continue;
          const f = parseFrontmatter(md).fields;
          ranked.push({
            id: e.entryId,
            score: cosine(vec, e.vector),
            title: String(f.title ?? e.entryId),
            summary: entrySummary(md),
          });
        }
        ranked.sort((x, y) => y.score - x.score);
        let top = ranked.slice(0, SWEEP.mergeCandidates);
        routing.candidates = top.slice(0, 3).map((r) => ({ id: r.id, score: Number(r.score.toFixed(3)) }));
        // Distill's target hint is a strong prior: it leads the candidate list.
        // The subject check still decides (a hint is never a bypass).
        let hinted = false;
        if (c.target && !superseded.has(c.target) && !anchors.ids.has(c.target)) {
          const tmd = readEntryMarkdown(roots, domain, c.target);
          if (tmd) {
            const f = parseFrontmatter(tmd).fields;
            const tv = entryVectors.find((e) => e.domain === domain && e.entryId === c.target);
            const lead = { id: c.target, score: tv ? cosine(vec, tv.vector) : 0, title: String(f.title ?? c.target), summary: entrySummary(tmd) };
            top = [lead, ...top.filter((r) => r.id !== c.target)].slice(0, SWEEP.mergeCandidates);
            routing.candidates = top.slice(0, 3).map((r) => ({ id: r.id, score: Number(r.score.toFixed(3)) }));
            routing.targetHint = c.target;
            hinted = true;
          } else {
            routing.targetHint = `${c.target} (not found)`;
          }
        }
        const band = hinted ? ({ kind: "ask" } as const) : mergeBand(top);
        routing.band = hinted ? "ask (target hint)" : band.kind;
        const scores = top.map((r) => r.score.toFixed(3)).join("/");
        if (band.kind === "merge") {
          targetId = band.id;
          routing.route = "similarity";
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → ${band.id} by similarity (${scores})`);
        } else if (band.kind === "ask") {
          const pick = await oracles.matchSubject({ title, summary: c.summary }, top);
          routing.subject = { match: pick.match, valid: pick.valid, reason: pick.reason };
          if (!pick.valid) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} subject check unparseable, creating a new entry`);
          if (pick.match !== "new") {
            targetId = pick.match;
            routing.route = "similarity";
          }
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} subject check (${scores}) → ${pick.match}${pick.reason ? ` (${pick.reason})` : ""}`);
          // Near miss: the title+summary check said "new" but the nearest entry
          // scored high (or distill named it). One more look with both FULL
          // texts; only "different" creates.
          const near = top[0];
          if (!targetId && near && (hinted || near.score >= SWEEP.nearMissScore)) {
            const nmd = readEntryMarkdown(roots, domain, near.id);
            if (nmd) {
              const second = await oracles.confirmSubject({ title, summary: c.summary, body: c.body }, { id: near.id, markdown: nmd });
              routing.confirm = { candidate: near.id, score: Number(near.score.toFixed(3)), merge: second.merge, valid: second.valid, reason: second.reason };
              if (second.merge) {
                targetId = near.id;
                routing.route = "similarity";
              }
              ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} near-miss check on ${near.id} (${near.score.toFixed(3)}) → ${second.merge ? "merge" : "different"}${second.reason ? ` (${second.reason})` : ""}`);
            }
          }
        }
      }

      // ── SIZE GUARD ──────────────────────────────────────────────────────
      // Never merge into an oversized entry: the merge rewrites the whole
      // entry. Create a new one instead; its alias is re-pointed on commit.
      // (Similarity candidates were already filtered by size above; this
      // catches an alias match.)
      // (A verbatim anchored entry is replaced whole, not merged: no guard.)
      if (targetId && !(c.anchor && c.verbatim)) {
        const size = readEntryMarkdown(roots, domain, targetId)?.length ?? 0;
        if (size > sizeLimit) {
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → new entry (target ${targetId} is ${size} chars, budget allows ${sizeLimit})`);
          routing.warning = `target ${targetId} is ${size} chars, over the ${sizeLimit} merge limit`;
          routing.route = "new";
          targetId = undefined;
        }
      }

      // ── ARCHIVE-SAFETY ──────────────────────────────────────────────────
      // An ARCHIVED contribution (e.g. a historical crawl) must never supersede
      // a NEWER LIVE entry: back-filled history cannot overwrite current truth.
      // Skip it (receipt + processed), leaving the live entry intact.
      if (targetId && c.currency === "archived" && c.sourceUpdated) {
        const md = readEntryMarkdown(roots, domain, targetId);
        const ef = md ? parseFrontmatter(md).fields : null;
        const existingLive = ef ? String(ef.currency ?? "live") !== "archived" : false;
        const existingUpdated = ef ? String(ef.updated ?? "") : "";
        if (existingLive && existingUpdated && c.sourceUpdated < existingUpdated) {
          writeReceipt(
            roots, c.from, c, "reject",
            `archived-older-than-live: ${c.sourceUpdated} < ${existingUpdated}`
          );
          markProcessed(c);
          result.rejected++;
          itemEvent = { outcome: "reject" };
          outcome = "rejected (archived, older than live entry)";
          return null;
        }
      }

      let sectionId: SectionId | undefined;
      let placement: Placement | undefined;

      // Updating a known entry → keep its existing section (identity stable).
      if (targetId) {
        const md = readEntryMarkdown(roots, domain, targetId);
        const sec = md ? String(parseFrontmatter(md).fields.section ?? "") : "";
        try {
          sectionId = SectionId.parse(sec);
          placement = { basis: "routed", fit: 1 };
        } catch {
          targetId = undefined; // couldn't resolve its section → place fresh
        }
      }

      // A grouped entry (a standing feature's) sits in its holder's section.
      if (!sectionId && c.group) {
        const holder = anchors.byKey.get(c.group);
        const hmd = holder ? readEntryMarkdown(roots, domain, holder) : null;
        try {
          if (hmd) {
            sectionId = SectionId.parse(String(parseFrontmatter(hmd).fields.section ?? ""));
            placement = { basis: "routed", fit: 1 };
          }
        } catch {
          sectionId = undefined; // the holder has no usable section: normal descent
        }
      }

      // A new entry is placed by deterministic tree descent.
      if (!sectionId) {
        // Build section members map for placeEntry (grouped entries follow their
        // holder and take no part in similarity placement)
        const sectionMembers = new Map<string, EWV[]>();
        for (const ev of entryVectors) {
          if (ev.domain !== domain) continue;
          if (anchors.grouped.has(ev.entryId)) continue;
          // Find which section this entry is in by checking frontmatter
          const entryMd = readEntryMarkdown(roots, domain, ev.entryId);
          const entrySec = entryMd ? String(parseFrontmatter(entryMd).fields.section ?? "") : "";
          if (entrySec) {
            if (!sectionMembers.has(entrySec)) sectionMembers.set(entrySec, []);
            sectionMembers.get(entrySec)!.push({ entryId: ev.entryId, sectionId: entrySec as SectionId, vector: ev.vector });
          }
        }
        const domainCentroid = computeCentroid(entryVectors.filter((e) => e.domain === domain && !anchors.grouped.has(e.entryId)).map((e) => e.vector));
        // placeEntry descends from the roots of its first section's domain, so it
        // must only see this domain's tree (it once routed entries from one domain into
        // another domain's sections).
        const domainSections = sections.filter((s) => s.domain === domain);
        const decision = placeEntry(vec, {}, domainSections, domainCentroid, sectionMembers);
        if (decision.sectionId !== "_unplaced") {
          sectionId = decision.sectionId as SectionId;
          placement = { basis: "routed", fit: clampFit(decision.fit) };
        } else {
          // ── CLASSIFY FALLBACK (LLM section-pick, confined) ──────────────
          const candidates = sections
            .filter((s) => s.domain === domain)
            .map((s) => ({ sectionId: s.id, title: s.title, summary: s.summary }));
          const pick = await oracles.classifyToSection(c.body, candidates);
          if (pick.section !== "NEW" && sections.some((s) => s.id === pick.section)) {
            sectionId = SectionId.parse(pick.section);
            placement = { basis: "routed", fit: clampFit(decision.fit) };
          } else {
            // NEW → singleton section under the domain (reorganized later).
            sectionId = mkSectionId(domain);
            const nowIso = IsoDate.parse(now().slice(0, 10));
            const slug =
              (c.summary || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
              "section";
            const newSection: Section = {
              id: sectionId,
              domain: DomainId.parse(domain),
              parent: null,
              depth: 0,
              label: Slug.parse(slug),
              title: c.summary.slice(0, 80) || "New section",
              centroid: vec,
              memberCount: 0,
              childIds: [],
              summary: c.summary || "(pending summary)",
              summaryHash: "",
              dirty: true, memberCountAtLastLabel: 0,
              created: nowIso,
              updated: nowIso,
            };
            sections = [...sections, newSection];
            batch.push(
              ev.sectionCreated({ sectionId, domain, parent: null, label: String(newSection.label) })
            );
            placement = { basis: "crystallized", fit: clampFit(decision.fit) };
          }
        }
      }

      if (!sectionId || !placement) throw new Error("unrouted contribution");
      if (targetId) {
        const size = readEntryMarkdown(roots, domain, targetId)?.length ?? 0;
        setRoute(`merge into ${targetId} (${size} chars)`);
      } else {
        setRoute(`create entry in ${sectionId}`);
      }

      // ── PRODUCE (LLM → opinion only; code assembles) ────────────────────
      const existingMarkdown = targetId ? readEntryMarkdown(roots, domain, targetId) ?? undefined : undefined;
      // An update keeps the entry's original creation date.
      const existingCreated = existingMarkdown ? String(parseFrontmatter(existingMarkdown).fields.created ?? "") || undefined : undefined;

      const liveIds = liveEntryIds(roots);
      const produceInput: ProduceEntryInput = {
        contribution: c,
        domain,
        section: sectionId,
        placement,
        entryId: targetId,
        existingMarkdown,
        existingCreated,
        resolve,
        liveIds,
        resolveLinks: (links) => links.map((id) => liveSurvivor(log, liveIds, id)).filter((id): id is string => !!id),
        allowOverflow: overflowOk,
      };
      // Verbatim: the anchored entry is the contribution as authored, no model call.
      const { entry: produced, action, unchanged, supersedes, historyRestored, lint, overflow, deduped } = c.anchor && c.verbatim
        ? produceVerbatim(produceInput)
        : await produceEntry(itemEngine, produceInput);
      const entry = withSourceProperties(produced, c.source, existingMarkdown);
      if (lint?.retried) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → produce retried for lint: ${lint.before.map((f) => f.code).join(",")}`);
      if (lint?.sizePass) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → size pass on ${entry.id}`);
      if (lint?.oversizeChars) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → kept oversize: ${entry.id} ${lint.oversizeChars}`);
      if (lint?.after.length) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → ${entry.id} kept with lint findings: ${lint.after.map((f) => f.code).join(",")}`);
      if (lint?.strippedLinks?.length) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → stripped ${lint.strippedLinks.length} link(s) to no entry from ${entry.id}: ${lint.strippedLinks.join(", ")}`);
      if (deduped?.length) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → collapsed ${deduped.length} duplicate paragraph/line(s) in ${entry.id}`);
      if (overflow) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → ${entry.id} covers two subjects: "${overflow.title}" is split out`);
      if (historyRestored?.length) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → restored ${historyRestored.length} History line(s) the model dropped from ${entry.id}`);

      // ── COMMIT (entry is live NOW) ──────────────────────────────────────
      // A decision the contribution agrees with is left exactly as it is.
      if (!unchanged) commitEntry(roots, entry);
      else if (existingMarkdown && targetId && sourceDiffers(existingMarkdown, entry)) {
        // The text is left as it is; only the code-set source properties move.
        atomicWrite(join(entriesDir(roots, domain), `${targetId}.md`), patchSourceProperties(existingMarkdown, entry));
      }
      committed = true;
      if (supersedes) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} supersedes decision ${supersedes} → new decision ${entry.id}`);

      batch.push(ev.contribution({
        from: c.from,
        denTopicId: c.denTopicId,
        hash: c.contentHash,
        prevHash: c.prevHash,
        domainHint: domain,
      }));
      if (!unchanged) {
        batch.push(ev.entryWritten(entry.id, entry.id, action));
        batch.push(ev.entryPlaced({
          entryId: entry.id,
          sectionId,
          basis: placement.basis,
          fit: placement.fit,
        }));
      }
      // Registry: record (wolf, den topic) -> entry so later re-promotes resolve
      // by alias and update in place. Re-fold so later items in THIS batch see it.
      batch.push(ev.aliased(c.from, c.denTopicId, entry.id, c.contentHash));
      reg = foldRegistry([...log, ...batch]);

      // The entry is live: record it in the ledger BEFORE anything else, so a
      // crash can't leave a live entry with no ledger record.
      appendLedger(roots, batch);
      log.push(...batch);
      batch.length = 0;
      touchedDomains.add(domain);

      // The holder's Delivered list follows its group, whichever side was written last.
      if (!unchanged && (c.anchor || c.group)) {
        const holderKeys = new Set<string>();
        if (c.group) holderKeys.add(c.group);
        if (c.anchor) holderKeys.add(c.anchor);
        for (const key of holderKeys) {
          try {
            if (syncDelivered(roots, domain, key)) ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → Delivered list of ${key} updated`);
          } catch (err) {
            ctx.notify?.(`sweep: could not sync the Delivered list of ${key}: ${cleanError(err)}`);
          }
        }
      }

      // Graduated work: note the entry on the work item (queued; never blocks).
      const workId = workIdOfTopic(c.denTopicId);
      if (workId && !unchanged) {
        try {
          queueWorkLink(roots, { workId, entryId: entry.id, action: action === "create" ? "created" : "updated" });
        } catch (err) {
          ctx.notify?.(`sweep: could not queue the work link for ${workId}: ${cleanError(err)}`);
        }
      }

      return { entry, action, domain, overflow, route: routing.route };
      };

      const placed = await place(c, domain, routing, !c.denTopicId.includes("~split-"));
      if (!placed) return;
      const { entry, action } = placed;
      // A second subject the produce step split out: committed after the main
      // entry, then routed like a new contribution (one level, no recursion).
      if (placed.overflow) {
        const o = overflowContribution(c, placed.overflow, placed.domain);
        const oRouting: RoutingRecord = { route: "new", candidates: [] };
        try {
          const op = await place(o, placed.domain, oRouting, false, placed.entry.id);
          if (op) {
            oRouting.target = op.entry.id;
            routing.overflow = { title: placed.overflow.title, denTopicId: o.denTopicId, target: op.entry.id, action: op.action, route: oRouting.route, candidates: oRouting.candidates, band: oRouting.band, subject: oRouting.subject, confirm: oRouting.confirm };
            ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → split: "${placed.overflow.title}" ${op.action === "create" ? "created" : "merged into"} ${op.entry.id}`);
            if (op.action === "create") result.created++;
            else result.merged++;
          }
        } catch (err) {
          // The main entry is live and the contribution counts as seen: the
          // second subject must not be lost, so it is queued as its own item.
          requeueOverflow(roots, o);
          routing.overflow = { title: placed.overflow.title, denTopicId: o.denTopicId, route: "queued", error: cleanError(err) };
          ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} → split "${placed.overflow.title}" queued for the next tick: ${cleanError(err)}`);
        }
      }

      routing.target = entry.id;
      writeReceipt(roots, c.from, c, action, entry.id, routing);
      markProcessed(c);
      itemEvent = { outcome: action === "create" ? "create" : "merge", entryId: entry.id };
      outcome = `${action === "create" ? "created" : "merged"} ${entry.id}`;
      if (action === "create") result.created++;
      else result.merged++;
      });
      clearAttempts(roots, c.contentHash);
      await noteSweepSuccess(roots, ctx.alert);
    } catch (err) {
      const reason = cleanError(err);
      result.processed--;
      result.errors++;
      if (classifyError(err) === "infra") {
        // Not the item's fault: no attempt is counted, the item stays queued,
        // and the sweeper backs off until the outage clears.
        const state = await noteInfraFailure(roots, err, ctx.alert);
        result.paused = state.reason;
        outcome = `infrastructure error, backing off (${state.consecutive} in a row): ${reason}`;
        ctx.notify?.(`sweep: ${c.from}/${c.denTopicId} not counted, ${outcome}`);
        continue;
      }
      // A budget overrun is retried SWEEP.budgetRetries times (no attempt
      // counted), then parked; other item errors count toward maxAttempts.
      // Some item errors (truncated output, no domain) repeat on every retry:
      // park those at once.
      const parkNow = shouldParkNow(err);
      const overrun = err instanceof BudgetExceeded;
      const overruns = overrun ? recordOverrun(roots, c, reason) : 0;
      const attempts = overrun ? 0 : recordFailure(roots, c, reason);
      if (parkNow || (overrun ? overruns > SWEEP.budgetRetries : attempts >= SWEEP.maxAttempts)) {
        // Unretryable, over budget twice, or out of attempts: park it.
        const why = parkNow
          ? String((err as { parkReason?: unknown }).parkReason ?? reason)
          : overrun ? `${reason} (${overruns} times)` : `failed ${attempts} times: ${reason}`;
        park(roots, c, why);
        outcome = `PARKED: ${why}`;
        itemEvent = { outcome: "parked" };
        ctx.notify?.(`sweep: parked ${c.from}/${c.denTopicId} — ${why}`);
        await Promise.resolve(ctx.alert?.(`sweep: parked ${c.from}/${c.denTopicId} — ${why}`)).catch(() => {});
        result.parked.push({ from: c.from, denTopicId: c.denTopicId, reason: why });
      } else if (overrun) {
        outcome = `skipped, over budget (${overruns}/${SWEEP.budgetRetries + 1}), will retry: ${reason}`;
        ctx.notify?.(`sweep: skipped ${c.from}/${c.denTopicId} — ${outcome}`);
        result.failures.push({ from: c.from, denTopicId: c.denTopicId, reason });
      } else {
        outcome = `skipped, attempt ${attempts}/${SWEEP.maxAttempts}: ${reason}`;
        ctx.notify?.(`sweep: skipped ${c.from}/${c.denTopicId} (attempt ${attempts}/${SWEEP.maxAttempts}) — ${reason}`);
        result.failures.push({ from: c.from, denTopicId: c.denTopicId, reason });
      }
    } finally {
      clearCurrent(roots);
      if (itemEvent) itemEvents.push({ type: "item", from: c.from, denTopicId: c.denTopicId, ...itemEvent });
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      ctx.notify?.(
        `item ${c.from}/${c.denTopicId}: ${route} · llm ${secs(llmMs)} · total ${secs(Date.now() - itemStart)} → ${outcome}`
      );
    }
  }

  result.touchedDomains = [...touchedDomains];

  // ── INDEX + DIGEST per touched domain ─────────────────────────────────────
  // The ledger already has this run's events; if rendering fails, the next tick
  // or a reorg re-renders, so log it and carry on to the registry and commit.
  try {
    if (touchedDomains.size > 0 && sections.length > 0) writeSections(roots, sections);
    for (const domain of touchedDomains) {
      renderDomainIndex(roots, domain);
      renderDomainDigest(roots, domain);
    }
  } catch (err) {
    ctx.notify?.(`sweep: index/digest rendering failed (ledger is written; next tick or reorg re-renders): ${cleanError(err)}`);
  }

  // ── PERSIST ────────────────────────────────────────────────────────────────
  try {
    if (batch.length > 0 || committed) {
      if (batch.length > 0) appendLedger(roots, batch);
      renderRegistry(roots, foldRegistry([...log, ...batch]));
      gitCommit(roots, `sweep: ${result.created}c ${result.merged}m ${result.rejected}r`);
    }
  } finally {
    for (const e of itemEvents) emit(e);
  }

  if (contributions.length > 0) ctx.notify?.(
    `sweep: ${result.processed} contributions → ${result.created}c ${result.merged}m` +
      (result.remaining > 0 ? ` · ${result.remaining} queued for next tick` : "")
  );
  return result;
}
