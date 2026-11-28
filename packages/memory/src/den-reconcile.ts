/**
 * Den reconcile — the den is a staging buffer, the KB is the source of truth.
 *
 * A den topic lives in the den until Dewey's sweep absorbs it. Dewey writes a
 * receipt per contribution to librarian-ops/receipts/<wolf>/<topic>-<hash10>.md,
 * keyed by the hash of the exact body emitted. When a receipt for a topic's
 * CURRENT body says create / merge / reject, the KB has that content (or newer
 * truth), so the topic moves to den/memory/archive/ and is no longer injected.
 *
 * Deterministic: no LLM, no network. Idempotent: a second run is a no-op.
 * A returning subject simply starts a fresh den topic under the same id; the
 * sweep's alias (wolf + den topic id) merges it into the same entry.
 */
import { existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import type { TopicOutcome } from "./topic-outcome.js";
import { contentHash, inboxDir, receiptsDir, type KbRoots } from "@wolfpack/kb/shared";
import { bodyHash, readDenTopicStates, readDenTopics, type DenTopic } from "./den.js";
import { readDistillRecord } from "./distill.js";

/** Receipt outcomes meaning the KB holds this content (or deliberately newer truth). */
const ABSORBED = new Set(["create", "merge", "reject"]);

export type DenTopicStatus =
  /** `entryId` is the primary entry; `entryIds` is every target of the receipt (primary first), empty for a reject. */
  | { kind: "absorbed"; entryId: string | null; entryIds: string[]; absorbedAt: string }
  | { kind: "awaiting-domain"; domain: string }
  | { kind: "parked" }
  | { kind: "held"; reason: string }
  | { kind: "awaiting-sweep" }
  | { kind: "pending-promote" };

export interface DenTopicState {
  topic: DenTopic;
  status: DenTopicStatus;
}

export interface ReconcileResult {
  archived: Array<{ id: string; entryId: string | null }>;
  pending: Array<{ id: string; status: Exclude<DenTopicStatus, { kind: "absorbed" }> }>;
}

export const denArchiveDir = (denRoot: string) => join(denRoot, "memory", "archive");

/** Receipt name stem for a topic body, as written by the sweep (`<id>-<hex[0..10]>`). */
function receiptStem(id: string, body: string): string {
  return `${id}-${contentHash(body.trim()).slice(7, 17)}`;
}

/** Every stem a receipt/inbox file for this body may carry: the canonical (trimmed) one, and the pre-trim one older writers used. */
function receiptStems(id: string, body: string): string[] {
  return [...new Set([receiptStem(id, body), `${id}-${contentHash(body).slice(7, 17)}`])];
}

type Receipt = { outcome: string; processed: string; detail: string; targets: string[] };

function readReceiptFor(dir: string, id: string, body: string): Receipt | null {
  for (const stem of receiptStems(id, body)) {
    const r = readReceipt(join(dir, `${stem}.md`));
    if (r) return r;
  }
  return null;
}

function readReceipt(path: string): Receipt | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1])?.[1]?.trim() ?? "";
  // routing.targets (all ids, primary first) when present, else routing.target; old receipts have neither.
  let targets: string[] = [];
  try {
    const routing = JSON.parse(field("routing") || "{}") as { target?: unknown; targets?: unknown };
    if (Array.isArray(routing.targets)) targets = routing.targets.filter((x): x is string => typeof x === "string" && x.length > 0);
    else if (typeof routing.target === "string" && routing.target) targets = [routing.target];
  } catch {
    targets = [];
  }
  return { outcome: field("outcome"), processed: field("processed"), detail: m[2].trim(), targets };
}

/** The entries the KB absorbed this exact body into (primary first), or null when no create/merge receipt names any. */
export function absorbedTargets(roots: KbRoots, wolf: string, id: string, body: string): string[] | null {
  const r = readReceiptFor(receiptsDir(roots, wolf), id, body);
  const a = r ? asAbsorbed(r) : null;
  return a && a.entryIds.length ? a.entryIds : null;
}

function readEmittedMap(roots: KbRoots): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(roots.denLocal, "emitted.json"), "utf-8")) ?? {};
  } catch {
    return {};
  }
}

/**
 * Where each den topic stands relative to the KB. Pure read; moves nothing.
 * Without KB roots nothing can be absorbed, so every topic is pending promote.
 */
export function denTopicStates(denRoot: string, roots: KbRoots | undefined, wolf: string): DenTopicState[] {
  const topics = readDenTopics(denRoot);
  if (!roots) return topics.map((topic) => ({ topic, status: heldIfNotPromotable(topic, { kind: "pending-promote" }) }));

  const receipts = receiptsDir(roots, wolf);
  const inbox = inboxDir(roots, wolf);
  const emitted = readEmittedMap(roots);

  return topics.map((topic): DenTopicState => ({ topic, status: heldIfNotPromotable(topic, statusOf(topic, roots, wolf, receipts, inbox, emitted)) }));
}

/**
 * A topic the promote gate holds (`promotable: false`) is never sent, so "pending promote" would wait forever for
 * nothing: it reads as held, with the reason the gate recorded. Any other status (absorbed, awaiting the sweep, ...) stands.
 */
function heldIfNotPromotable(topic: DenTopic, status: DenTopicStatus): DenTopicStatus {
  if (topic.promotable || status.kind !== "pending-promote") return status;
  return { kind: "held", reason: topic.promotableReason || "not promotable" };
}

/**
 * What the sweep sees for a topic. A promoted topic is emitted DISTILLED, so
 * its receipts are keyed by the distilled bodies recorded at promote; a topic
 * without a (current) record was emitted raw. It is absorbed once every
 * contribution it produced is.
 */
function statusOf(
  topic: DenTopic,
  roots: KbRoots,
  wolf: string,
  receipts: string,
  inbox: string,
  emitted: Record<string, string>
): DenTopicStatus {
  const rec = readDistillRecord(roots, topic.id);
  const current = rec && contentHash(rec.rawBody.trim()) === contentHash(topic.body.trim()) ? rec : null;
  if (current?.held) return { kind: "held", reason: `distill: ${current.held}${current.heldDetail ? `\n${current.heldDetail}` : ""}` };
  const parts = current ? current.outputs.map((o) => ({ id: o.id, body: o.body })) : [{ id: topic.id, body: topic.body }];

  const states = parts.map((p): DenTopicStatus => {
    const r = readReceiptFor(receipts, p.id, p.body);
    const absorbed = r ? asAbsorbed(r) : null;
    if (absorbed) return absorbed;
    if (r?.outcome === "unclassified") {
      const domain = /pending domain:\s*(\S+)/.exec(r.detail)?.[1] ?? "unknown";
      return { kind: "awaiting-domain", domain };
    }
    if (r?.outcome === "parked") return { kind: "parked" };
    const wasEmitted = emitted[p.id] === contentHash(p.body.trim()) || emitted[p.id] === contentHash(p.body) || receiptStems(p.id, p.body).some((s) => existsSync(join(inbox, `${s}.md`)));
    return { kind: wasEmitted ? "awaiting-sweep" : "pending-promote" };
  });
  // The first part that is not absorbed decides; all absorbed → absorbed (first part's entry).
  return states.find((s) => s.kind !== "absorbed") ?? states[0];
}

function asAbsorbed(r: Receipt): Extract<DenTopicStatus, { kind: "absorbed" }> | null {
  if (!ABSORBED.has(r.outcome)) return null;
  // create/merge receipts name the entry; reject names the reason instead.
  const entryId = /^kb-\S+$/.test(r.detail) ? r.detail : null;
  const entryIds = r.outcome === "reject" ? [] : r.targets.length ? r.targets : entryId ? [entryId] : [];
  return { kind: "absorbed", entryId: entryIds[0] ?? entryId, entryIds, absorbedAt: r.processed };
}

/**
 * True when the KB already absorbed exactly this content for this topic. Promote
 * uses it to skip re-writing unchanged session topics into the den (a long-lived
 * session would otherwise resurrect every absorbed topic on each promote).
 */
export function isAbsorbed(roots: KbRoots, wolf: string, id: string, body: string): boolean {
  return absorbedEntryIds(roots, wolf, id, body) !== null;
}

/** The rule behind isAbsorbed, with the entries it found (primary first, empty for an old receipt that names none); null when not absorbed. */
export function absorbedEntryIds(roots: KbRoots, wolf: string, id: string, body: string): string[] | null {
  const rec = readDistillRecord(roots, id);
  if (rec && !rec.held && contentHash(rec.rawBody.trim()) === contentHash(body.trim())) {
    const ids: string[] = [];
    for (const o of rec.outputs) {
      const r = readReceiptFor(receiptsDir(roots, wolf), o.id, o.body);
      const a = r ? asAbsorbed(r) : null;
      if (!a) return null;
      for (const e of a.entryIds) if (!ids.includes(e)) ids.push(e);
    }
    return ids;
  }
  const r = readReceiptFor(receiptsDir(roots, wolf), id, body);
  const a = r ? asAbsorbed(r) : null;
  return a ? a.entryIds : null;
}

/**
 * What the KB said about a topic, for the promote pass. Reads the receipts; when they still say pending but the
 * consolidate skip rule (isAbsorbed) judged one of `bodies` already in the KB, the topic is recorded as promoted into
 * the entries that rule found. Without this a skipped topic never got a receipt in the promote state and stayed
 * "pending promote" forever. A topic that did not reach the KB stays pending and is sent again.
 */
export function kbOutcome(denRoot: string, roots: KbRoots, wolf: string, topic: { id: string }, bodies: string[]): TopicOutcome {
  const s = denTopicStates(denRoot, roots, wolf).find((x) => x.topic.id === topic.id)?.status;
  if (!s) return { kind: "pending" };
  switch (s.kind) {
    case "absorbed": return s.entryIds.length ? { kind: "create", entryIds: s.entryIds } : { kind: "reject" };
    case "parked": return { kind: "parked" };
    case "awaiting-domain": return { kind: "parked" };
    case "held": return { kind: "held", reason: s.reason };
    default: {
      // bodies[0] is the den body. A session body counts only while the den file is still what consolidate wrote from it:
      // a den body edited since (its session_hash no longer matches) is new content the KB has not seen.
      const den = readDenTopicStates(denRoot).get(topic.id);
      const edited = !!den?.sessionHash && den.sessionHash !== bodyHash(den.body);
      for (const b of edited ? bodies.slice(0, 1) : bodies) {
        const ids = absorbedEntryIds(roots, wolf, topic.id, b);
        if (!ids) continue;
        // A reject receipt names no entry: it is a reject, as in the absorbed case above.
        return ids.length ? { kind: "create", entryIds: ids } : { kind: "reject" };
      }
      return { kind: "pending" };
    }
  }
}

/** Add absorbed_into / absorbed_at to a topic file's frontmatter. */
function annotate(raw: string, entryId: string | null, absorbedAt: string): string {
  const extra = `absorbed_into: ${entryId ?? "null"}\nabsorbed_at: ${absorbedAt}`;
  const m = /^(---\n[\s\S]*?)\n---\n/.exec(raw);
  return m ? `${m[1]}\n${extra}\n---\n${raw.slice(m[0].length)}` : `---\n${extra}\n---\n\n${raw}`;
}

/**
 * Archive every den topic the KB has absorbed; report the rest as pending.
 * An archived file keeps its original content plus absorbed_into/absorbed_at.
 */
export function reconcileDen(denRoot: string, roots: KbRoots | undefined, wolf: string): ReconcileResult {
  const result: ReconcileResult = { archived: [], pending: [] };
  const archive = denArchiveDir(denRoot);

  for (const { topic, status } of denTopicStates(denRoot, roots, wolf)) {
    if (status.kind !== "absorbed") {
      result.pending.push({ id: topic.id, status });
      continue;
    }
    mkdirSync(archive, { recursive: true });
    // A subject archived before keeps its earlier file; this one gets a hash suffix.
    let dest = join(archive, `${topic.id}.md`);
    if (existsSync(dest)) dest = join(archive, `${receiptStem(topic.id, topic.body)}.md`);
    atomicWrite(dest, annotate(readFileSync(topic.filePath, "utf-8"), status.entryId, status.absorbedAt));
    unlinkSync(topic.filePath);
    result.archived.push({ id: topic.id, entryId: status.entryId });
  }
  return result;
}

/** Short human label for a pending status, as shown to the wolf. */
export function describeStatus(status: Exclude<DenTopicStatus, { kind: "absorbed" }>): string {
  switch (status.kind) {
    case "awaiting-domain": return `awaiting domain: ${status.domain}`;
    case "parked": return "parked by sweep";
    case "held": return `held back (${status.reason})`;
    case "awaiting-sweep": return "awaiting sweep";
    case "pending-promote": return "pending promote";
  }
}
