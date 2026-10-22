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
import { contentHash, inboxDir, receiptsDir, type KbRoots } from "@wolfpack/kb/shared";
import { readDenTopics, type DenTopic } from "./den.js";
import { readDistillRecord } from "./distill.js";

/** Receipt outcomes meaning the KB holds this content (or deliberately newer truth). */
const ABSORBED = new Set(["create", "merge", "reject"]);

export type DenTopicStatus =
  | { kind: "absorbed"; entryId: string | null; absorbedAt: string }
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
  return `${id}-${contentHash(body).slice(7, 17)}`;
}

function readReceipt(path: string): { outcome: string; processed: string; detail: string } | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1])?.[1]?.trim() ?? "";
  return { outcome: field("outcome"), processed: field("processed"), detail: m[2].trim() };
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
  if (!roots) return topics.map((topic) => ({ topic, status: { kind: "pending-promote" } }));

  const receipts = receiptsDir(roots, wolf);
  const inbox = inboxDir(roots, wolf);
  const emitted = readEmittedMap(roots);

  return topics.map((topic): DenTopicState => ({ topic, status: statusOf(topic, roots, wolf, receipts, inbox, emitted) }));
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
  if (current?.held) return { kind: "held", reason: `distill: ${current.held}` };
  const parts = current ? current.outputs.map((o) => ({ id: o.id, body: o.body })) : [{ id: topic.id, body: topic.body }];

  const states = parts.map((p): DenTopicStatus => {
    const stem = receiptStem(p.id, p.body);
    const r = readReceipt(join(receipts, `${stem}.md`));
    const absorbed = r ? asAbsorbed(r) : null;
    if (absorbed) return absorbed;
    if (r?.outcome === "unclassified") {
      const domain = /pending domain:\s*(\S+)/.exec(r.detail)?.[1] ?? "unknown";
      return { kind: "awaiting-domain", domain };
    }
    if (r?.outcome === "parked") return { kind: "parked" };
    const wasEmitted = emitted[p.id] === contentHash(p.body) || existsSync(join(inbox, `${stem}.md`));
    return { kind: wasEmitted ? "awaiting-sweep" : "pending-promote" };
  });
  // The first part that is not absorbed decides; all absorbed → absorbed (first part's entry).
  return states.find((s) => s.kind !== "absorbed") ?? states[0];
}

function asAbsorbed(r: { outcome: string; processed: string; detail: string }): Extract<DenTopicStatus, { kind: "absorbed" }> | null {
  if (!ABSORBED.has(r.outcome)) return null;
  // create/merge receipts name the entry; reject names the reason instead.
  const entryId = /^kb-\S+$/.test(r.detail) ? r.detail : null;
  return { kind: "absorbed", entryId, absorbedAt: r.processed };
}

/**
 * True when the KB already absorbed exactly this content for this topic. Promote
 * uses it to skip re-writing unchanged session topics into the den (a long-lived
 * session would otherwise resurrect every absorbed topic on each promote).
 */
export function isAbsorbed(roots: KbRoots, wolf: string, id: string, body: string): boolean {
  const rec = readDistillRecord(roots, id);
  if (rec && !rec.held && contentHash(rec.rawBody.trim()) === contentHash(body.trim())) {
    return rec.outputs.every((o) => {
      const r = readReceipt(join(receiptsDir(roots, wolf), `${receiptStem(o.id, o.body)}.md`));
      return !!(r && asAbsorbed(r));
    });
  }
  const r = readReceipt(join(receiptsDir(roots, wolf), `${receiptStem(id, body.trim())}.md`));
  return !!(r && asAbsorbed(r));
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
