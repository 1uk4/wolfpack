/**
 * `hubd kb-backfill --aliases --dewey-ledger <file> --data-dir <dir> [--dry-run]`
 *
 * Copies Dewey's `aliased` and `entry_retired` events into the hub KB ledger, so the curator's exact-alias routing
 * (sweep.ts: foldRegistry -> topic.aliases -> resolveAliasedEntry, which follows entry_retired to a survivor) works for topics Dewey
 * already knew, instead of falling back to similarity and creating duplicates. Also fills `_registry.md` aliases.
 *
 * Why a separate mode (and why --force is not needed): the normal backfill refuses a ledger with curator (non-`bf-`) events, because it
 * appends OLD-dated decisions that the activity reader (file order) would treat as newest. This mode appends neither decisions nor
 * contributions. Its two event types are made order-safe by rule instead:
 *  - foldRegistry orders by FILE POSITION, not `at` (the latest aliased event for a (wolf, denTopicId) wins). An appended old alias would
 *    therefore beat a curator alias written earlier in the file. So an `aliased` event is NEVER copied for a key that already has a
 *    non-`bf-` alias in the hub ledger (reported as skipped); the curator's alias stays the latest. Keys with only `bf-` aliases are
 *    re-run safe by id.
 *  - `entry_retired` is skipped when the hub ledger holds a non-`bf-` entry_written for that entry (the curator rewrote it after Dewey
 *    retired it; a copied retire would drop it again).
 *  - Copied events keep Dewey's relative order (alias vs retire matter for the fold) and keep his `at`.
 * Ids: `bf-` + sha256(kind, source event id (or its fields)), so re-runs append nothing. Everything runs under the KB writer lock.
 * Report: counts per type, skipped keys, and alias targets with no entry file in the hub KB and no `entry_retired` survivor (still emitted).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendLedger, entryDomain, readLedger, survivorOf, withKbLock } from "@wolfpack/kb/librarian";
import { KbEventSchema, ledgerFile, type KbEvent } from "@wolfpack/kb/shared";
import { toIsoUtc, DEFAULT_BACKFILL_TZ } from "./kb-backfill.js";
import { hubRoots } from "./layout.js";
import { existsSync as exists } from "node:fs";
import { join } from "node:path";

export interface AliasBackfillOptions {
  deweyLedger: string;
  dataDir: string;
  dryRun?: boolean;
  tz?: string;
}
export interface AliasBackfillReport {
  dryRun: boolean;
  aliasedBuilt: number;
  retiredBuilt: number;
  appended: number;
  alreadyPresent: number;
  perType: Record<string, number>;
  /** (wolf:denTopicId) keys the hub curator already aliased: not copied. */
  skippedKeys: string[];
  skippedRetired: string[];
  /** Alias targets with no entry file in the hub KB and no entry_retired survivor (still emitted). */
  unresolvedTargets: string[];
  invalid: number;
  samples: KbEvent[];
}

const id = (kind: string, key: string): string => `bf-${createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 16)}`;

export async function kbBackfillAliases(opts: AliasBackfillOptions): Promise<AliasBackfillReport> {
  const roots = hubRoots(opts.dataDir);
  const tz = opts.tz ?? DEFAULT_BACKFILL_TZ;
  const rep: AliasBackfillReport = { dryRun: !!opts.dryRun, aliasedBuilt: 0, retiredBuilt: 0, appended: 0, alreadyPresent: 0, perType: {}, skippedKeys: [], skippedRetired: [], unresolvedTargets: [], invalid: 0, samples: [] };
  const src: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(opts.deweyLedger, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o)) src.push(o as Record<string, unknown>);
    } catch { /* torn line */ }
  }
  const str = (e: Record<string, unknown>, k: string): string | undefined => (typeof e[k] === "string" && e[k] ? (e[k] as string) : undefined);

  const run = (): void => {
    const hub = existsSync(ledgerFile(roots)) ? readLedger(roots) : [];
    const have = new Set(hub.map((e) => e.id));
    const curatorAlias = new Set<string>();
    const curatorWritten = new Set<string>();
    for (const e of hub) {
      if (e.id.startsWith("bf-")) continue;
      if (e.t === "aliased") curatorAlias.add(`${e.wolf}:${e.denTopicId}`);
      else if (e.t === "entry_written") curatorWritten.add(e.entryId);
    }
    const events: KbEvent[] = [];
    const skippedKeys = new Set<string>();
    for (const s of src) {
      const kind = s.t;
      if (kind !== "aliased" && kind !== "entry_retired") continue;
      const at = toIsoUtc(str(s, "at"), tz);
      const srcKey = str(s, "id") ?? JSON.stringify(s);
      let ev: KbEvent;
      if (kind === "aliased") {
        const wolf = str(s, "wolf"), den = str(s, "denTopicId"), canonicalId = str(s, "canonicalId"), hash = str(s, "hash");
        const cand = { id: id("aliased", srcKey), at: at ?? "", t: "aliased", wolf: wolf ?? "", denTopicId: den ?? "", canonicalId: canonicalId ?? "", hash: hash ?? "" };
        if (!at || !wolf || !den || !canonicalId || !hash) { rep.invalid++; continue; }
        if (curatorAlias.has(`${wolf}:${den}`)) { skippedKeys.add(`${wolf}:${den}`); continue; }
        ev = cand as KbEvent;
      } else {
        const entryId = str(s, "entryId");
        if (!at || !entryId) { rep.invalid++; continue; }
        if (curatorWritten.has(entryId)) { rep.skippedRetired.push(entryId); continue; }
        ev = { id: id("entry_retired", srcKey), at, t: "entry_retired", entryId, ...(str(s, "reason") ? { reason: str(s, "reason")! } : {}) } as KbEvent;
      }
      if (!KbEventSchema.safeParse(ev).success) { rep.invalid++; continue; }
      events.push(ev);
    }
    // Survivor lookup sees Dewey's retire events too (they are about to be in the ledger).
    const view: KbEvent[] = [...hub, ...events];
    const unresolved = new Set<string>();
    for (const e of events) {
      if (e.t !== "aliased") continue;
      const dom = entryDomain(e.canonicalId);
      let cur = e.canonicalId, ok = false;
      for (let hop = 0; hop < 5 && cur; hop++) {
        const d = entryDomain(cur) ?? dom;
        if (d && exists(join(roots.kbBase, "domains", d, "entries", `${cur}.md`))) { ok = true; break; }
        cur = survivorOf(view, cur) ?? "";
      }
      if (!ok) unresolved.add(e.canonicalId);
    }
    for (const e of events) {
      rep.perType[e.t] = (rep.perType[e.t] ?? 0) + 1;
      if (e.t === "aliased") rep.aliasedBuilt++;
      else rep.retiredBuilt++;
    }
    const fresh = events.filter((e) => !have.has(e.id));
    rep.alreadyPresent = events.length - fresh.length;
    rep.skippedKeys = [...skippedKeys].sort();
    rep.unresolvedTargets = [...unresolved].sort();
    rep.samples = fresh.slice(0, 3);
    if (opts.dryRun) return;
    appendLedger(roots, fresh);
    rep.appended = fresh.length;
  };
  if (opts.dryRun) run();
  else await withKbLock(roots, async () => run());
  return rep;
}

export function formatAliasBackfillReport(r: AliasBackfillReport): string[] {
  const p = (x: string): string => x.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return [
    `kb-backfill --aliases${r.dryRun ? " (dry run, nothing written)" : ""}: aliased ${r.aliasedBuilt}, entry_retired ${r.retiredBuilt}; appended ${r.appended}, already present ${r.alreadyPresent}, invalid ${r.invalid}`,
    `skipped alias keys (the hub curator already aliased them): ${r.skippedKeys.length}`,
    ...r.skippedKeys.slice(0, 20).map((k) => `  ${p(k)}`),
    `skipped entry_retired (curator rewrote the entry): ${r.skippedRetired.length}`,
    `alias targets with no entry file and no entry_retired survivor (emitted anyway): ${r.unresolvedTargets.length}`,
    ...r.unresolvedTargets.slice(0, 20).map((k) => `  ${p(k)}`),
    ...r.samples.map((e) => `sample: ${p(JSON.stringify(e))}`),
  ];
}
