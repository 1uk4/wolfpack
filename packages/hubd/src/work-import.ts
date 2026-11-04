/**
 * `hubd work-import --from-domains <dir> --from-ledger <file> --data-dir <hubd data dir> [--dry-run] [--domains personal,wolfpack]`
 *
 * One-off (re-runnable) merge of the LEGACY work store (wolfpack-agent: `<from-domains>/<d>/work/*.md` + its ledger) into hubd's
 * store so hubd is the single store, followed by a SEED step so every item hubd holds as a file is also known to the ledger (hubd's
 * write path folds the ledger only; an item that exists only as a file returns 404 on writes). The sources are only read.
 *
 * Ledger: dedupe key = sha256 of the canonical JSON (sorted keys, all fields incl. `by`/`tokenId`) of the raw event. Events carry no
 * event id, and two genuinely identical events can exist (same note text in the same minute), so the key is a MULTISET: if legacy holds
 * n copies and hubd m, n-m are appended. Re-running therefore adds nothing.
 * Order: foldWork depends on file order, so each source keeps its OWN order and the heads are compared by `at` (a k-way merge; a
 * line without a usable `at` (hubd's unparseable lines, kept verbatim) counts as "same as its predecessor"; legacy events with a
 * non-date `at` are skipped and counted as malformed, since foldWork throws on them; ties: hubd, then legacy, then seeds). A source that is not monotonic
 * keeps its order, never reshuffled. If nothing is appended the ledger is not touched; otherwise it is rewritten atomically
 * (tmp + rename), after the backup.
 *
 * Files: legacy-only .md are copied; for an item in both, the version with the newer effective `updated` wins, where effective =
 * max(file `updated`, date of that store's last ledger event for the item). Strictly newer legacy => hubd's file is replaced; strictly
 * newer hubd => kept; equal => the file whose stage matches the MERGED ledger's folded stage wins; else a conflict, hubd's kept.
 * hubd-only files are never deleted.
 *
 * Seed: for every file (in hubd's dirs after the file step) whose id the merged ledger never mentions, the events the read path's
 * `seedEvents` makes for it (work.created + links/summary/schedule/standing/graduated) are appended with `by: "hubd-work-import-seed"`,
 * `at` = the file's created / updated day. A file whose id is already in the ledger (even deleted) is never seeded, so a re-run seeds
 * nothing. Unreadable files are an ERROR (nothing is written); malformed / invalid files are skipped with a warning and counted.
 *
 * Safety: takes the work-writer lock (acquireWorkWriterLock, the one `hubd serve`, export and work-orphans use) even for a dry run,
 * so it refuses while hubd runs. Backs up the ledger and the target work dirs under `<dataDir>/backups/work-import-<stamp>/` first.
 * Every file is written tmp + rename; a crash mid-run is safe to re-run (files first, the ledger last; each step is idempotent).
 */
import { createHash } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { foldWork, parseWorkEvent, parseWorkFile, type WorkEvent } from "@wolfpack/kb/client";
import { workDir, workLedgerFile } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { DOMAIN_RE, loadMergedWorkState, seedEvents } from "./work-reads.js";

export interface ImportOptions {
  fromDomains: string;
  fromLedger: string;
  dataDir: string;
  dryRun?: boolean;
  domains?: string[];
  /** Test seam: the backup dir stamp. */
  now?: () => Date;
  /** Warnings (skipped files, ownership). Default: console.warn. */
  warn?: (m: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  domains: string[];
  eventsToAppend: number;
  /** Legacy events whose domain is not in --domains (e.g. snapjack): not imported. */
  eventsOutOfScope: number;
  filesToAdd: string[];
  filesToUpdate: Array<{ id: string; from: string; to: string; reason: string }>;
  decisions: Array<{ id: string; legacyStage: string; hubdStage: string; legacyUpdated: string; hubdUpdated: string; decision: "legacy" | "hubd" | "conflict-kept-hubd" }>;
  conflicts: string[];
  skippedMalformedLines: number;
  /** Migration-duplicate collapse within the legacy source (in-scope events): before, after, drops per rule, the list file, items kept whole. */
  dedupe: { before: number; after: number; dropped: Record<DropRule, number>; file?: string; fellBack: string[]; differences: string[] };
  /** Malformed / invalid work files (not unreadable ones: those abort the run). */
  skippedFiles: string[];
  /** Seed events to append, and the items they cover, per domain. */
  seedEvents: number;
  seedItems: Record<string, number>;
  seedSkipped: string[];
  backupDir?: string;
  mismatches: string[];
  checked: number;
  /** After the import (also in dry-run, simulated): items with boundBy set, grouped by wolf. */
  bound: Record<string, number>;
  ownershipNotes: string[];
}

export type DropRule = "exact" | "note" | "adjacent" | "noop-stage";

export const DEFAULT_IMPORT_DOMAINS = ["personal", "wolfpack"];
export const SEED_BY = "hubd-work-import-seed";

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const keyOf = (raw: unknown): string => createHash("sha256").update(JSON.stringify(canon(raw))).digest("hex");
/** The domain segment of a work id. [a-z0-9]+ is DOMAIN_RE minus hyphens: the WorkId shape (`work-<alnum domain>-<7 id>`) has no hyphen in the domain, so a hyphenated domain cannot be addressed by id anyway; every result is re-checked against DOMAIN_RE. */
const domainOfId = (id: string): string | undefined => {
  const d = /^work-([a-z0-9]+)-/.exec(id)?.[1];
  return d && DOMAIN_RE.test(d) ? d : undefined;
};
const validAt = (at: unknown): at is string => typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at);

interface Line { text: string; eff: string; id: string; key: string; event: WorkEvent }
/** One ledger line in file order: parsed (`line`) or kept verbatim (hubd side only). */
interface Entry { text: string; eff: string; line?: Line }

/** Read a ledger read-only. `eff` = the line's `at`, or its predecessor's when malformed / empty. */
function readLedger(file: string): { lines: Line[]; all: Entry[]; bad: number } {
  const lines: Line[] = [];
  const all: Entry[] = [];
  let bad = 0;
  let prev = "";
  if (!existsSync(file)) return { lines, all, bad };
  for (const text of readFileSync(file, "utf-8").split("\n")) {
    if (!text.trim()) continue;
    let line: Line | undefined;
    try {
      const raw = JSON.parse(text);
      const event = parseWorkEvent(raw);
      // An event whose `at` is not a date parses but THROWS in foldWork (dateOf), which would poison every hubd write: never import one.
      if (event && validAt(event.at)) {
        prev = String(event.at);
        line = { text, eff: prev, id: event.id as string, key: keyOf(raw), event };
      }
    } catch { /* counted below */ }
    if (!line) bad++;
    all.push({ text, eff: prev, ...(line ? { line } : {}) });
    if (line) lines.push(line);
  }
  return { lines, all, bad };
}

/** K-way merge: each stream keeps its own order, the smallest head `eff` goes next, ties to the earlier stream. */
function mergeStreams<T extends { eff: string }>(streams: T[][]): T[] {
  const idx = streams.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let pick = -1;
    for (let s = 0; s < streams.length; s++) {
      const h = streams[s]![idx[s]!];
      if (h && (pick < 0 || h.eff < streams[pick]![idx[pick]!]!.eff)) pick = s;
    }
    if (pick < 0) return out;
    out.push(streams[pick]![idx[pick]!++]!);
  }
}

type Parsed = { id: string; stage: string; updated: string; raw: Buffer };
/** Read a work file. `undefined` = malformed (not a work file); an unreadable file THROWS (EACCES, EIO ...): the operator must fix permissions, a silent skip would drop the item. */
function readWorkFile(path: string): Parsed | undefined {
  const raw = readFileSync(path);
  const r = parseWorkFile(raw.toString("utf-8"), path);
  if (!r || !r.item.id || !r.item.stage) return undefined;
  return { id: String(r.item.id), stage: String(r.item.stage), updated: String(r.item.updated ?? "").slice(0, 10), raw };
}

const isRoot = () => process.getuid?.() === 0;
/** tmp + rename in the target's dir. `mode`: the file mode to create; `like`: an existing file whose owner/group to keep (root: chown both; others: try the group). */
function atomicPut(target: string, data: Buffer | string, mode: number, like: string | undefined, notes: string[]): void {
  const tmp = join(dirname(target), `.${process.pid}.${Date.now()}.import.tmp`);
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    const st = like ? statSync(like) : statSync(dirname(target));
    try {
      if (isRoot()) chownSync(tmp, like ? st.uid : -1, st.gid);
      else chownSync(tmp, -1, st.gid);
    } catch (e) {
      notes.push(`could not set the group of ${target}: ${(e as Error).message}`);
    }
    const o = statSync(tmp);
    if (notes.length < 50 && (o.uid !== st.uid || o.gid !== st.gid) && like) notes.push(`${target}: owner ${o.uid}:${o.gid} (replaced file had ${st.uid}:${st.gid})`);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

interface Dropped { line: Line; rule: DropRule }
const withoutAt = (e: WorkEvent): string => JSON.stringify(canon({ ...(e as object), at: undefined }));

/**
 * Collapse migration duplicates inside the legacy source, in its own order (hubd's events are never touched):
 *  - exact: same canonical JSON as an earlier kept event (never for work.staged);
 *  - note: work.noted with the same id and text as an earlier kept one (first occurrence wins, `at` ignored);
 *  - adjacent: equals, ignoring `at`, the immediately preceding kept event of the same id (any type except noted/staged);
 *  - noop-stage: work.staged to the item's current (legacy-folded) stage; any other staged event is always kept.
 * `exempt` ids keep every event (used when the collapse would change that item's folded state).
 */
function collapseDuplicates(lines: Line[], exempt: Set<string>): { kept: Line[]; dropped: Dropped[] } {
  const kept: Line[] = [];
  const dropped: Dropped[] = [];
  const seenKeys = new Set<string>();
  const seenNotes = new Set<string>();
  const last = new Map<string, string>();
  const stage = new Map<string, string>();
  for (const l of lines) {
    const e = l.event as WorkEvent & { text?: string; to?: string; stage?: string };
    const keep = () => {
      kept.push(l);
      seenKeys.add(l.key);
      last.set(l.id, `${e.type}\0${withoutAt(l.event)}`);
      if (e.type === "work.created") stage.set(l.id, e.stage ?? "plan");
      else if (e.type === "work.staged") stage.set(l.id, e.to!);
      else if (e.type === "work.deleted") stage.delete(l.id);
      if (e.type === "work.noted") seenNotes.add(`${l.id}\0${e.text}`);
    };
    if (exempt.has(l.id)) { keep(); continue; }
    let rule: DropRule | undefined;
    if (e.type === "work.staged") { if (stage.get(l.id) === e.to) rule = "noop-stage"; }
    else if (seenKeys.has(l.key)) rule = "exact";
    else if (e.type === "work.noted" && seenNotes.has(`${l.id}\0${e.text}`)) rule = "note";
    else if (e.type !== "work.noted" && last.get(l.id) === `${e.type}\0${withoutAt(l.event)}`) rule = "adjacent";
    if (rule) dropped.push({ line: l, rule });
    else keep();
  }
  return { kept, dropped };
}

/** The folded fields that must be identical with and without the collapse (only log lengths may shrink). */
const FOLD_FIELDS = ["stage", "title", "assignee", "partOf", "graduated", "kind", "domain", "area", "successCriteria", "summary", "container", "standing", "scheduledFor", "durationMinutes", "boundBy", "dependsOn", "blocks"] as const;
function foldDifferences(a: Line[], b: Line[]): string[] {
  const fa = foldWork(a.map((l) => l.event));
  const fb = foldWork(b.map((l) => l.event));
  const diffs: string[] = [];
  for (const id of new Set([...fa.keys(), ...fb.keys()])) {
    const x = fa.get(id) as Record<string, unknown> | undefined, y = fb.get(id) as Record<string, unknown> | undefined;
    if (!x || !y) { diffs.push(id as string); continue; }
    if (FOLD_FIELDS.some((k) => JSON.stringify(x[k] ?? null) !== JSON.stringify(y[k] ?? null))) diffs.push(id as string);
  }
  return diffs;
}

export function importWork(opts: ImportOptions): ImportReport {
  const warn = opts.warn ?? ((m: string) => console.warn(`hubd work-import: ${m}`));
  const domains = opts.domains ?? DEFAULT_IMPORT_DOMAINS;
  if (domains.length === 0) throw new Error("--domains is empty");
  for (const d of domains) if (!DOMAIN_RE.test(d)) throw new Error(`invalid domain "${d}": lower-case letters, digits and hyphens only`);
  if (!existsSync(opts.fromLedger)) throw new Error(`legacy ledger not found: ${opts.fromLedger}`);
  if (!existsSync(opts.fromDomains)) throw new Error(`legacy domains dir not found: ${opts.fromDomains}`);
  const dry = !!opts.dryRun;
  const roots = hubRoots(opts.dataDir);
  let lock: { release(): void };
  try {
    lock = acquireWorkWriterLock(opts.dataDir);
  } catch (e) {
    throw new Error(`cannot run: a hub (or another writer) holds ${opts.dataDir}; stop hubd first (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    const inScope = (id: string) => domains.includes(domainOfId(id) ?? "");
    const report: ImportReport = {
      dryRun: dry, domains, eventsToAppend: 0, eventsOutOfScope: 0, filesToAdd: [], filesToUpdate: [], decisions: [], conflicts: [],
      skippedMalformedLines: 0, dedupe: { before: 0, after: 0, dropped: { exact: 0, note: 0, adjacent: 0, "noop-stage": 0 }, fellBack: [], differences: [] }, skippedFiles: [], seedEvents: 0, seedItems: {}, seedSkipped: [], mismatches: [], checked: 0, bound: {}, ownershipNotes: [],
    };

    // ── ledger: legacy events hubd lacks, merged in ──
    const legacy = readLedger(opts.fromLedger);
    const hubdFile = workLedgerFile(roots);
    const hubd = readLedger(hubdFile);
    report.skippedMalformedLines = legacy.bad;
    const have = new Map<string, number>();
    for (const l of hubd.lines) have.set(l.key, (have.get(l.key) ?? 0) + 1);
    const scoped: Line[] = [];
    for (const l of legacy.lines) { if (inScope(l.id)) scoped.push(l); else report.eventsOutOfScope++; }
    // Collapse migration duplicates FIRST, then diff against hubd, so a re-run never re-appends what the collapse dropped.
    let exempt = new Set<string>();
    let { kept, dropped } = collapseDuplicates(scoped, exempt);
    const diffs = foldDifferences(scoped, kept);
    if (diffs.length) {
      exempt = new Set(diffs); // fall back: these items keep every event; the collapse must never change folded state
      report.dedupe.fellBack = diffs;
      ({ kept, dropped } = collapseDuplicates(scoped, exempt));
    }
    report.dedupe.differences = foldDifferences(scoped, kept);
    report.dedupe.before = scoped.length;
    report.dedupe.after = kept.length;
    for (const d of dropped) report.dedupe.dropped[d.rule]++;
    const seen = new Map<string, number>();
    const fresh: Entry[] = []; // legacy order kept
    for (const l of kept) {
      const n = (seen.get(l.key) ?? 0) + 1;
      seen.set(l.key, n);
      if (n > (have.get(l.key) ?? 0)) fresh.push({ text: l.text, eff: l.eff, line: l });
    }
    report.eventsToAppend = fresh.length;
    const merged = mergeStreams<Entry>([hubd.all, fresh]);
    let ledgerFold: ReturnType<typeof foldWork>;
    try {
      ledgerFold = foldWork(merged.flatMap((e) => (e.line ? [e.line.event] : [])));
    } catch (e) {
      throw new Error(`the merged ledger does not fold (${(e as Error).message}); hubd's own ledger may already be damaged. Nothing was written`);
    }

    // ── files ──
    const lastDay = (ls: Line[]) => {
      const m = new Map<string, string>();
      for (const l of ls) { const d = l.eff.slice(0, 10); if (d && (m.get(l.id) ?? "") < d) m.set(l.id, d); }
      return m;
    };
    const legacyDay = lastDay(legacy.lines);
    const hubdDay = lastDay(hubd.lines);
    const writes: Array<{ target: string; data: Buffer; mode: number; like: string | undefined }> = [];
    const legacyStages = new Map<string, { domain: string; stage: string }>();
    for (const d of domains) {
      const src = join(opts.fromDomains, d, "work");
      if (!existsSync(src)) continue;
      const dst = workDir(roots, d);
      for (const f of readdirSync(src).filter((n) => n.endsWith(".md")).sort()) {
        const lf = readWorkFile(join(src, f)); // throws when unreadable
        if (!lf || `${lf.id}.md` !== f || domainOfId(lf.id) !== d) { report.skippedFiles.push(`${d}/${f}`); warn(`skipping malformed legacy work file ${d}/${f}`); continue; }
        legacyStages.set(lf.id, { domain: d, stage: lf.stage });
        const target = join(dst, f);
        const hf = existsSync(target) ? readWorkFile(target) : undefined;
        if (!hf) {
          if (existsSync(target)) { report.skippedFiles.push(`${d}/${f} (hubd copy malformed; kept)`); warn(`hubd copy of ${d}/${f} is malformed; kept as is`); continue; }
          report.filesToAdd.push(lf.id);
          writes.push({ target, data: lf.raw, mode: 0o664, like: undefined });
          continue;
        }
        if (hf.raw.equals(lf.raw)) continue;
        const lEff = [lf.updated, legacyDay.get(lf.id) ?? ""].sort().pop()!;
        const hEff = [hf.updated, hubdDay.get(hf.id) ?? ""].sort().pop()!;
        let decision: "legacy" | "hubd" | "conflict-kept-hubd" = lEff > hEff ? "legacy" : hEff > lEff ? "hubd" : "conflict-kept-hubd";
        if (decision === "conflict-kept-hubd") {
          // Same age: the merged ledger is the source of truth, so the file that agrees with its folded stage wins.
          const folded = (ledgerFold.get(lf.id as never) as { stage?: string } | undefined)?.stage;
          if (folded && folded === lf.stage && folded !== hf.stage) decision = "legacy";
          else if (folded && folded === hf.stage && folded !== lf.stage) decision = "hubd";
        }
        report.decisions.push({ id: lf.id, legacyStage: lf.stage, hubdStage: hf.stage, legacyUpdated: lEff, hubdUpdated: hEff, decision });
        if (decision === "legacy") {
          report.filesToUpdate.push({ id: lf.id, from: hf.stage, to: lf.stage, reason: lEff > hEff ? `legacy ${lEff} > hubd ${hEff}` : `same age ${lEff}; legacy stage matches the ledger` });
          writes.push({ target, data: lf.raw, mode: statSync(target).mode & 0o7777, like: target });
        } else if (decision === "conflict-kept-hubd") report.conflicts.push(lf.id);
      }
    }

    // ── seed: files (as they will be) whose id the merged ledger never mentions ──
    const mentioned = new Set<string>(merged.flatMap((e) => (e.line ? [e.line.id] : [])));
    const planned = new Map(writes.map((w) => [w.target, w.data]));
    const seeds: Entry[] = [];
    const seededIds = new Set<string>();
    for (const d of domains) {
      const dir = workDir(roots, d);
      const names = new Set<string>(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : []);
      for (const w of writes) if (dirname(w.target) === dir) names.add(w.target.slice(dir.length + 1));
      const items: Array<{ it: NonNullable<ReturnType<typeof parseWorkFile>>["item"]; name: string }> = [];
      for (const f of [...names].sort()) {
        const path = join(dir, f);
        const raw = planned.get(path) ?? readFileSync(path); // unreadable => throws
        const r = parseWorkFile(raw.toString("utf-8"), path);
        const id = f.slice(0, -3);
        if (!r || r.item.id !== id || r.item.domain !== d) { report.seedSkipped.push(`${d}/${f}`); warn(`not seeding ${d}/${f}: not a valid work item`); continue; }
        if (mentioned.has(id)) continue;
        items.push({ it: r.item, name: f });
      }
      // The item's events stay together (ordered by the created day), so they sort in front of anything later for other items.
      items.sort((a, b) => (String(a.it.created) < String(b.it.created) ? -1 : String(a.it.created) > String(b.it.created) ? 1 : a.name < b.name ? -1 : 1));
      for (const { it, name } of items) {
        let evs: WorkEvent[];
        try {
          evs = seedEvents(it, SEED_BY);
          if (evs.length === 0) throw new Error("invalid work item");
          foldWork(evs);
        } catch (e) {
          report.seedSkipped.push(`${d}/${name}`);
          warn(`not seeding ${d}/${name}: ${(e as Error).message}`);
          continue;
        }
        // The fold dates `updated` by the last event: make sure it ends on the file's `updated` day.
        const last = String(evs[evs.length - 1]!.at).slice(0, 10);
        if (String(it.updated) > last) evs.push(parseWorkEvent({ type: "work.staged", id: it.id, at: `${it.updated} 00:00`, to: it.stage, by: SEED_BY })!);
        const eff = String(evs[0]!.at);
        for (const e of evs) seeds.push({ text: JSON.stringify(e), eff, line: { text: "", eff, id: it.id as string, key: "", event: e } });
        seededIds.add(it.id as string);
        report.seedItems[d] = (report.seedItems[d] ?? 0) + 1;
      }
    }
    report.seedEvents = seeds.length;
    const finalEntries = mergeStreams<Entry>([merged, seeds]);
    const finalEvents = finalEntries.flatMap((e) => (e.line ? [e.line.event] : []));
    const finalFold = foldWork(finalEvents);
    for (const it of finalFold.values()) if (it.boundBy) report.bound[it.boundBy as string] = (report.bound[it.boundBy as string] ?? 0) + 1;

    const stampNow = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const listDropped = (): string => dropped.map((d) => `${d.rule}\t${d.line.id}\t${d.line.event.type}\t${d.line.event.at}\t${String((d.line.event as { text?: string }).text ?? (d.line.event as { to?: string }).to ?? "").replace(/\s+/g, " ").slice(0, 60)}`).join("\n") + "\n";
    if (dry) {
      // The one thing a dry run writes: the list of dropped duplicates, beside (not inside) any backup.
      if (dropped.length) {
        const f = join(opts.dataDir, "backups", `work-import-dryrun-${stampNow}-dropped.tsv`);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, listDropped());
        report.dedupe.file = f;
      }
      return report;
    }
    const ledgerChanges = report.eventsToAppend > 0 || report.seedEvents > 0;
    if (!ledgerChanges && writes.length === 0) return check(report, roots, domains, legacyStages);

    // ── backup, then write: files first, the ledger last (a crash in between is re-run safely) ──
    const backupDir = join(opts.dataDir, "backups", `work-import-${stampNow}`);
    mkdirSync(join(backupDir, "ledger"), { recursive: true });
    if (existsSync(hubdFile)) cpSync(hubdFile, join(backupDir, "ledger", "work-events.jsonl"), { preserveTimestamps: true });
    for (const d of domains) {
      const dir = workDir(roots, d);
      if (existsSync(dir)) cpSync(dir, join(backupDir, "kb", "base", "domains", d, "work"), { recursive: true, dereference: true, preserveTimestamps: true });
    }
    report.backupDir = backupDir;
    if (dropped.length) {
      report.dedupe.file = join(backupDir, "dropped-duplicates.tsv");
      writeFileSync(report.dedupe.file, listDropped());
    }
    for (const w of writes) {
      mkdirSync(dirname(w.target), { recursive: true });
      atomicPut(w.target, w.data, w.mode, w.like, report.ownershipNotes);
    }
    if (ledgerChanges) {
      mkdirSync(dirname(hubdFile), { recursive: true });
      const like = existsSync(hubdFile) ? hubdFile : undefined;
      atomicPut(hubdFile, finalEntries.map((e) => e.text).join("\n") + "\n", like ? statSync(like).mode & 0o7777 : 0o644, like, report.ownershipNotes);
    }
    return check(report, roots, domains, legacyStages);
  } finally {
    lock.release();
  }
}

/**
 * Consistency check on the written result. The ledger-only fold (what hubd's write path sees) must agree with (a) every legacy file and
 * (b) every hubd file on stage, title, assignee, partOf and graduated; and its log length must equal the read path's (merged) log length.
 * On a catch-up run a mismatch can be legitimate: an item hubd has advanced since is newer than its file.
 */
function check(report: ImportReport, roots: ReturnType<typeof hubRoots>, domains: string[], legacyStages: Map<string, { domain: string; stage: string }>): ImportReport {
  const ledgerOnly = foldWork(readLedger(workLedgerFile(roots)).lines.map((l) => l.event));
  for (const it of ledgerOnly.values()) if (it.boundBy) report.bound[it.boundBy as string] = 0; // recount from the written ledger
  report.bound = {};
  for (const it of ledgerOnly.values()) if (it.boundBy) report.bound[it.boundBy as string] = (report.bound[it.boundBy as string] ?? 0) + 1;
  for (const d of domains) {
    const dir = workDir(roots, d);
    if (!existsSync(dir)) continue;
    const read = loadMergedWorkState(roots, d);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const r = parseWorkFile(readFileSync(join(dir, f), "utf-8"), join(dir, f));
      if (!r || r.item.id !== f.slice(0, -3) || r.item.domain !== d) continue; // reported as skipped already
      const id = r.item.id as string;
      report.checked++;
      const got = ledgerOnly.get(id as never) as Record<string, unknown> | undefined;
      if (!got) { report.mismatches.push(`${id}: unknown to the ledger-only fold (hubd writes would 404)`); continue; }
      for (const k of ["stage", "title", "assignee", "partOf", "graduated"] as const) {
        // The frontmatter parser leaves \" and \\ escapes of quoted titles as typed; unescape so a quoted title is not a false mismatch.
        const unq = (v: unknown) => (k === "title" && typeof v === "string" ? v.replace(/\\(["\\])/g, "$1") : v);
        const a = unq(got[k] ?? null), b = unq((r.item as Record<string, unknown>)[k] ?? null);
        if (a !== b) report.mismatches.push(`${id}: ${k} ledger "${String(a)}" vs file "${String(b)}"`);
      }
      const rl = ((read.get(id) as { log?: unknown[] } | undefined)?.log ?? []).length;
      const ll = ((got.log as unknown[] | undefined) ?? []).length;
      if (rl !== ll) report.mismatches.push(`${id}: log length ledger ${ll} vs read ${rl}`);
    }
  }
  for (const [id, { stage }] of legacyStages) {
    const got = ledgerOnly.get(id as never) as { stage?: string } | undefined;
    if (got && got.stage !== stage) { /* already covered when the hubd file differs; also report the legacy view */
      const msg = `${id}: ledger stage ${got.stage} vs legacy file ${stage}`;
      if (!report.mismatches.some((m) => m.startsWith(`${id}: stage`))) report.mismatches.push(msg);
    }
  }
  return report;
}

export function formatReport(r: ImportReport): string[] {
  const seedLine = Object.entries(r.seedItems).map(([d, n]) => `${d} ${n}`).join(", ") || "none";
  const out = [
    `hubd work-import${r.dryRun ? " (dry run, nothing written)" : ""}: domains ${r.domains.join(",")}`,
    `legacy events in scope: ${r.dedupe.before}; after collapsing migration duplicates: ${r.dedupe.after} (dropped: ${Object.entries(r.dedupe.dropped).map(([k, n]) => `${k} ${n}`).join(", ")})${r.dedupe.file ? `; list: ${r.dedupe.file}` : ""}`,
    `dedupe check (folded state with vs without the collapse): ${r.dedupe.differences.length} difference(s)${r.dedupe.fellBack.length ? `; ${r.dedupe.fellBack.length} item(s) kept whole: ${r.dedupe.fellBack.slice(0, 10).join(", ")}` : ""}`,
    `events to append: ${r.eventsToAppend}`,
    `${r.eventsOutOfScope} events out of scope (other domains, not imported)`,
    `files to add: ${r.filesToAdd.length}`,
    `files to update: ${r.filesToUpdate.length}`,
    `conflicts (same age, differing; hubd kept): ${r.conflicts.length}`,
    `seed: ${r.seedEvents} events for ${Object.values(r.seedItems).reduce((a, b) => a + b, 0)} file-only items (${seedLine}); skipped ${r.seedSkipped.length}`,
    `malformed ledger lines: ${r.skippedMalformedLines}`,
    `skipped files: ${r.skippedFiles.length}`,
  ];
  for (const f of r.skippedFiles) out.push(`  skipped ${f}`);
  for (const f of r.seedSkipped) out.push(`  not seeded ${f}`);
  for (const d of r.decisions) out.push(`  both stores ${d.id}: legacy ${d.legacyStage} (${d.legacyUpdated}) vs hubd ${d.hubdStage} (${d.hubdUpdated}) -> ${d.decision}`);
  for (const u of r.filesToUpdate) out.push(`  update ${u.id}: ${u.from} -> ${u.to} (${u.reason})`);
  const bound = Object.entries(r.bound);
  out.push(`items bound (boundBy set) after the import: ${bound.reduce((a, [, n]) => a + n, 0)}${bound.length ? ` (${bound.map(([w, n]) => `${w}: ${n}`).join(", ")})` : ""}`);
  if (r.backupDir) out.push(`backup: ${r.backupDir}`);
  for (const n of r.ownershipNotes.slice(0, 20)) out.push(`  note: ${n}`);
  if (!r.dryRun) {
    out.push(`consistency check: ${r.checked} files, ${r.mismatches.length} mismatch(es)`);
    for (const m of r.mismatches) out.push(`  MISMATCH ${m}`);
  }
  return out;
}
