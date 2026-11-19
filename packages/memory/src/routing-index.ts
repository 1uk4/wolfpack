/**
 * Routing index, `<den>/memory/routing-index.json`: subject → the KB entries that subject was filed into.
 *
 * Written only from create or merge receipts (`recordRouting`, every target of the receipt, primary first) and from a
 * reject (`recordReject`: a marker only; a later topic on the same subject can still be promoted). Consolidation and
 * promotion read it as a target hint for new topics on the same subject. Links are resolved at USE time through a
 * resolver the caller passes in (the kb package's `resolveAliasedEntry`; memory does not import kb internals):
 * a retired entry resolves to its survivor and the link is rewritten, a link that resolves to nothing is dropped.
 */
import { readJsonState, writeJsonState } from "./state-json.js";

const FILE = "routing-index.json";

export interface RoutingSubject {
  /** Entries the subject was filed into, primary first. Empty for a reject marker. */
  entryIds: string[];
  rejectedAt?: string;
}
export interface RoutingIndex {
  version: 1;
  subjects: Record<string, RoutingSubject>;
}

/** Subjects compare case- and whitespace-insensitively. */
export const subjectKey = (subject: string): string => subject.trim().replace(/\s+/g, " ").toLowerCase();

export function readRoutingIndex(den: string): RoutingIndex {
  const raw = readJsonState<Partial<RoutingIndex>>(den, FILE, {});
  return { version: 1, subjects: raw.subjects && typeof raw.subjects === "object" ? raw.subjects : {} };
}

/** A create/merge receipt confirmed `entryIds` (primary first) for `subject`. */
export function recordRouting(den: string, subject: string, entryIds: string[], _now: Date = new Date()): void {
  const ids = [...new Set(entryIds.filter(Boolean))];
  if (!ids.length) return;
  const index = readRoutingIndex(den);
  index.subjects[subjectKey(subject)] = { entryIds: ids };
  writeJsonState(den, FILE, index);
}

/** A reject receipt: keep a marker, no target. */
export function recordReject(den: string, subject: string, now: Date = new Date()): void {
  const index = readRoutingIndex(den);
  const key = subjectKey(subject);
  if (index.subjects[key]?.entryIds.length) return; // a real link outranks a marker
  index.subjects[key] = { entryIds: [], rejectedAt: now.toISOString() };
  writeJsonState(den, FILE, index);
}

/**
 * The entry to file a new topic on `subject` into, or null. `resolve` maps an id to the live entry id (following
 * retirement to a survivor) or null when nothing is left. Resolved links are rewritten; dead ones are dropped.
 */
export function routingHint(den: string, subject: string, resolve: (entryId: string) => string | null): string | null {
  const index = readRoutingIndex(den);
  const key = subjectKey(subject);
  const hit = index.subjects[key];
  if (!hit || !hit.entryIds.length) return null;
  const live = [...new Set(hit.entryIds.map((id) => resolve(id)).filter((id): id is string => !!id))];
  if (live.join("\n") !== hit.entryIds.join("\n")) {
    if (live.length) index.subjects[key] = { ...hit, entryIds: live };
    else delete index.subjects[key];
    writeJsonState(den, FILE, index);
  }
  return live[0] ?? null;
}
