/**
 * The promote pass: consolidation only folds the pool into session topics; this is the separate step that publishes
 * topics to the KB and retires the ones that are done. Pure over injected deps (the KB promote, the receipt lookup, the
 * alias resolver, the held-topic rewrite), so memory imports no kb internals.
 *
 * Triggers: the owner clicks Promote (all topics, or the given ids); a feature graduates (topics sourced from it);
 * the daily pass (topics whose source threads have all been quiet 8 active hours). `keep_local` topics are never
 * promoted by a pass; only an explicit owner click on that id does.
 *
 * Retiring (move to `retired/` beside `evicted/`, never a delete) needs all three: promoted, a create/merge receipt
 * confirmed it, inactive 8 active hours. A still-active topic stays local even when promoted. Nothing closes threads.
 */
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { activeHoursSince } from "./active-hours.js";
import { readPromoteState, updateTopicState } from "./promote-state.js";
import { recordReject, recordRouting, routingHint } from "./routing-index.js";
import { readTopics, writeTopic, type TopicFile } from "./session/memory.js";

export const QUIET_ACTIVE_HOURS = 8;
export const RETIRED_DIR = "retired";

export type PassTrigger =
  | { kind: "owner"; ids?: string[] }
  | { kind: "graduation"; featureId: string }
  | { kind: "daily" }
  | { kind: "migration" };

/** What the KB said about a topic after promote (from its receipts / distill record). */
export type TopicOutcome =
  | { kind: "create" | "merge"; entryIds: string[] }
  | { kind: "reject" }
  | { kind: "parked" }
  | { kind: "held"; reason: string }
  | { kind: "pending" };

export interface PassDeps {
  /** Distill and emit these topics to the KB (never throws for one bad topic). */
  promote: (topics: TopicFile[]) => Promise<void>;
  outcomeOf: (topic: TopicFile) => TopicOutcome;
  /** The kb package's resolveAliasedEntry, as a function: id → live entry id (following retirement) or null. */
  resolveEntry: (entryId: string) => string | null;
  /** One forced rewrite of a held topic; true when the topic is now fine to promote. */
  rewriteHeld: (topic: TopicFile, reason: string) => Promise<boolean>;
}

export interface PassOptions extends PassDeps {
  den: string;
  /** The session topics directory (`<den>/.memory/sessions/durable`). */
  root: string;
  trigger: PassTrigger;
  now?: Date;
}

export interface PassResult {
  promoted: string[];
  retired: string[];
  parked: string[];
  held: string[];
}

/** The activity clock of a topic: its last note, else its updated stamp, else null (treated as long quiet). */
export function topicActivity(t: TopicFile): Date | null {
  const raw = t.lastNote ?? (t.updated ? `${t.updated.trim().replace(" ", "T")}${/(Z|[+-]\d\d:?\d\d)$/.test(t.updated.trim()) ? "" : "Z"}` : "");
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Quiet = at least `QUIET_ACTIVE_HOURS` active hours since the topic's last note. A topic with no clock is quiet. */
export function isQuiet(den: string, t: TopicFile): boolean {
  const at = topicActivity(t);
  return at === null || activeHoursSince(den, at) >= QUIET_ACTIVE_HOURS;
}

function selects(den: string, t: TopicFile, trigger: PassTrigger): boolean {
  switch (trigger.kind) {
    case "owner": return trigger.ids ? trigger.ids.includes(t.id) : !t.keepLocal;
    case "graduation": return !t.keepLocal && (t.sources ?? []).includes(trigger.featureId);
    case "daily": return !t.keepLocal && isQuiet(den, t);
    case "migration": return !t.keepLocal && (isQuiet(den, t) || (t.sources ?? []).includes("legacy"));
  }
}

/** Move a topic to `<root>/retired/`. Never deletes; an older retired file of the same name keeps a dated name. */
export function retireTopic(root: string, t: TopicFile, now: Date): void {
  const dest = join(root, RETIRED_DIR);
  mkdirSync(dest, { recursive: true });
  const target = existsSync(join(dest, t.filename)) ? join(dest, t.filename.replace(/\.md$/, `-${now.getTime().toString(36)}.md`)) : join(dest, t.filename);
  renameSync(join(root, t.filename), target);
}

export async function runPromotePass(opts: PassOptions): Promise<PassResult> {
  const { den, root, trigger } = opts;
  const now = opts.now ?? new Date();
  const result: PassResult = { promoted: [], retired: [], parked: [], held: [] };

  const chosen = readTopics(root).filter((t) => selects(den, t, trigger));
  if (chosen.length) {
    await opts.promote(chosen);
    for (const t of chosen) result.promoted.push(t.id);
  }

  const chosenIds = new Set(chosen.map((t) => t.id));
  for (const t of readTopics(root)) {
    if (chosenIds.has(t.id)) {
      const out = opts.outcomeOf(t);
      if (out.kind === "create" || out.kind === "merge") {
        recordRouting(den, t.id, out.entryIds, now);
        updateTopicState(den, t.id, { promotedAt: now.toISOString(), receipt: { outcome: out.kind, entryIds: out.entryIds } });
      } else if (out.kind === "reject") {
        recordReject(den, t.id, now);
        updateTopicState(den, t.id, { promotedAt: now.toISOString(), receipt: { outcome: "reject", entryIds: [] }, retiredAt: now.toISOString() });
        retireTopic(root, t, now);
        result.retired.push(t.id);
        continue;
      } else if (out.kind === "parked") {
        if (t.state !== "parked") writeTopic(root, { ...t, updated: t.updated, lastNote: t.lastNote, keepLocal: t.keepLocal, state: "parked" });
        updateTopicState(den, t.id, { state: "parked" });
        result.parked.push(t.id);
        continue;
      } else if (out.kind === "held") {
        result.held.push(t.id);
        const seen = readPromoteState(den).topics[t.id]?.heldRewriteTried;
        if (seen) {
          updateTopicState(den, t.id, { retiredAt: now.toISOString() });
          retireTopic(root, t, now);
          result.retired.push(t.id);
        } else {
          updateTopicState(den, t.id, { heldRewriteTried: true });
          const fixed = await opts.rewriteHeld(t, out.reason);
          if (fixed) {
            const again = readTopics(root).find((x) => x.id === t.id);
            if (again) {
              await opts.promote([again]);
              const o2 = opts.outcomeOf(again);
              if (o2.kind === "create" || o2.kind === "merge") {
                recordRouting(den, t.id, o2.entryIds, now);
                updateTopicState(den, t.id, { promotedAt: now.toISOString(), receipt: { outcome: o2.kind, entryIds: o2.entryIds } });
              }
            }
          }
        }
        continue;
      }
    }
    // Retire rule: promoted + confirmed by a create/merge receipt + inactive 8 active hours.
    const st = readPromoteState(den).topics[t.id];
    const confirmed = st?.promotedAt && (st.receipt?.outcome === "create" || st.receipt?.outcome === "merge");
    if (confirmed && isQuiet(den, t) && !st?.retiredAt) {
      updateTopicState(den, t.id, { retiredAt: now.toISOString() });
      retireTopic(root, t, now);
      result.retired.push(t.id);
    }
  }
  return result;
}

/** Set or clear a topic's `keep_local` flag, keeping every other field. False when the topic does not exist. */
export function setKeepLocal(root: string, topicId: string, keepLocal: boolean): boolean {
  const t = readTopics(root).find((x) => x.id === topicId);
  if (!t) return false;
  writeTopic(root, { id: t.id, title: t.title, summary: t.summary, updated: t.updated, body: t.body, domain: t.domain, sources: t.sources, lastNote: t.lastNote, state: t.state, keepLocal: keepLocal || undefined });
  return true;
}

/** 180 KB across all session topics. */
export const TOPICS_BYTE_CAP = 180 * 1024;
/** An oversized topic (characters) must be split by subject. */
export const TOPIC_CHAR_CAP = 8000;

/**
 * Keep the session topics under `maxBytes` in total. Least recently updated first, never a keep-local topic: a topic a
 * receipt confirmed is retired (retired/), any other is evicted (evicted/). Both are moves, never deletes.
 */
export function enforceByteCap(o: { den: string; root: string; maxBytes?: number; now?: Date }): { retired: string[]; evicted: string[] } {
  const max = o.maxBytes ?? TOPICS_BYTE_CAP;
  const now = o.now ?? new Date();
  const out = { retired: [] as string[], evicted: [] as string[] };
  const topics = readTopics(o.root).map((t) => ({ t, bytes: (() => { try { return statSync(join(o.root, t.filename)).size; } catch { return 0; } })() }));
  let total = topics.reduce((n, x) => n + x.bytes, 0);
  if (total <= max) return out;
  const stamp = (t: TopicFile) => topicActivity({ ...t, lastNote: undefined })?.getTime() ?? 0;
  const order = topics.filter((x) => !x.t.keepLocal).sort((a, b) => stamp(a.t) - stamp(b.t) || (a.t.filename < b.t.filename ? -1 : 1));
  for (const { t, bytes } of order) {
    if (total <= max) break;
    const st = readPromoteState(o.den).topics[t.id];
    const confirmed = !!st?.promotedAt && (st.receipt?.outcome === "create" || st.receipt?.outcome === "merge");
    if (confirmed) {
      updateTopicState(o.den, t.id, { retiredAt: now.toISOString() });
      retireTopic(o.root, t, now);
      out.retired.push(t.id);
    } else {
      const dest = join(o.root, "evicted");
      mkdirSync(dest, { recursive: true });
      const name = existsSync(join(dest, t.filename)) ? t.filename.replace(/\.md$/, `-${now.getTime().toString(36)}.md`) : t.filename;
      renameSync(join(o.root, t.filename), join(dest, name));
      out.evicted.push(t.id);
    }
    total -= bytes;
  }
  return out;
}

/** The target hint for a new topic on `subject`: its KB entry, resolved now through `resolveEntry`. */
export function targetHint(den: string, subject: string, resolveEntry: (id: string) => string | null): string | null {
  return routingHint(den, subject, resolveEntry);
}
