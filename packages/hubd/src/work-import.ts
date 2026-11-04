/**
 * `hubd work-import --from-domains <dir> --from-ledger <file> --data-dir <hubd data dir> [--dry-run] [--domains personal,wolfpack]`
 *
 * One-off (re-runnable) merge of the LEGACY work store (wolfpack-agent: `<from-domains>/<d>/work/*.md` + its ledger) into hubd's
 * store so hubd is the single store. The sources are only ever opened for reading.
 *
 * Ledger: dedupe key = sha256 of the canonical JSON (sorted keys, all fields incl. `by`/`tokenId`) of the raw event. Events carry no
 * event id of their own, and two genuinely identical events can exist (same note text in the same minute), so the key is used as a
 * MULTISET: if the legacy ledger holds n copies of a key and hubd's holds m, n-m are appended. Re-running therefore adds nothing.
 * Order: foldWork depends on file order (a staged/deleted event needs its work.created first, later events override earlier), so the
 * result is a stable two-way merge by the `at` timestamp ("YYYY-MM-DD HH:MM"): the new events are stably sorted by `at`, hubd's own order is kept, ties go to hubd's
 * events. When nothing is appended the ledger file is not touched; otherwise it is rewritten atomically (tmp + rename), backup first.
 *
 * Files: legacy-only .md are copied; for an item in both, the version with the newer effective `updated` wins, where effective =
 * max(file `updated`, date of that store's last ledger event for the item). Strictly newer legacy => hubd's file is replaced;
 * strictly newer hubd => kept; equal and different => reported as a conflict, hubd's kept. hubd-only files are never deleted.
 * Note readers apply the ledger on top of the files, so the merged ledger decides stage whatever file is kept.
 *
 * Safety: takes the work-writer lock (acquireWorkWriterLock, the one `hubd serve`, export and work-orphans use) even for a dry run,
 * so it refuses while hubd runs. Backs up the ledger and the target work dirs under `<dataDir>/backups/work-import-<stamp>/` first.
 * Every write is tmp + rename, with mode/owner copied from the file it replaces (or the work dir for a new file).
 */
import { createHash } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireWorkWriterLock, parseFrontmatter } from "@wolfpack/engine";
import { foldWork, parseWorkEvent, type WorkEvent } from "@wolfpack/kb/client";
import { workDir, workLedgerFile } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { DOMAIN_RE, loadMergedWorkState } from "./work-reads.js";

export interface ImportOptions {
  fromDomains: string;
  fromLedger: string;
  dataDir: string;
  dryRun?: boolean;
  domains?: string[];
  /** Test seam: the backup dir stamp. */
  now?: () => Date;
}

export interface ImportReport {
  dryRun: boolean;
  domains: string[];
  eventsToAppend: number;
  filesToAdd: string[];
  filesToUpdate: Array<{ id: string; from: string; to: string; reason: string }>;
  /** Items in both stores whose files differ: what was decided (also for the updates above). */
  decisions: Array<{ id: string; legacyStage: string; hubdStage: string; legacyUpdated: string; hubdUpdated: string; decision: "legacy" | "hubd" | "conflict-kept-hubd" }>;
  conflicts: string[];
  skippedMalformedLines: number;
  skippedFiles: string[];
  backupDir?: string;
  /** After a real import: legacy items whose merged stage differs from the legacy file's, or that the ledger-only fold does not know. */
  mismatches: string[];
  checked: number;
}

export const DEFAULT_IMPORT_DOMAINS = ["personal", "wolfpack"];

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const keyOf = (raw: unknown): string => createHash("sha256").update(JSON.stringify(canon(raw))).digest("hex");
const domainOfId = (id: string): string | undefined => /^work-([a-z0-9]+)-/.exec(id)?.[1];

interface Line { text: string; at: string; id: string; key: string; event: WorkEvent }

/** Read a ledger read-only. Malformed / unparseable lines count as skipped (and are kept verbatim when `keepBad`, for the hubd side). */
function readLines(file: string): { lines: Line[]; bad: string[] } {
  const lines: Line[] = [];
  const bad: string[] = [];
  if (!existsSync(file)) return { lines, bad };
  for (const text of readFileSync(file, "utf-8").split("\n")) {
    if (!text.trim()) continue;
    try {
      const raw = JSON.parse(text);
      const event = parseWorkEvent(raw);
      if (!event) { bad.push(text); continue; }
      lines.push({ text, at: String(event.at), id: event.id as string, key: keyOf(raw), event });
    } catch {
      bad.push(text);
    }
  }
  return { lines, bad };
}

function readWorkFile(path: string): { id: string; stage: string; updated: string; raw: Buffer } | undefined {
  try {
    const raw = readFileSync(path);
    const { fields } = parseFrontmatter(raw.toString("utf-8"));
    if (!fields.id || fields.nodeType !== "work" || !fields.stage) return undefined;
    return { id: String(fields.id), stage: String(fields.stage), updated: String(fields.updated ?? "").slice(0, 10), raw };
  } catch {
    return undefined;
  }
}

/** tmp + rename in the target's own dir; mode/owner from `like` (an existing path) when given. */
function atomicPut(target: string, data: Buffer | string, like: string): void {
  const st = statSync(like);
  const tmp = join(dirname(target), `.${process.pid}.${Date.now()}.import.tmp`);
  writeFileSync(tmp, data, { mode: st.mode & 0o7777 });
  chmodSync(tmp, st.mode & 0o666 || 0o644);
  if (process.getuid?.() === 0) chownSync(tmp, st.uid, st.gid);
  renameSync(tmp, target);
}

export function importWork(opts: ImportOptions): ImportReport {
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
    const report: ImportReport = { dryRun: dry, domains, eventsToAppend: 0, filesToAdd: [], filesToUpdate: [], decisions: [], conflicts: [], skippedMalformedLines: 0, skippedFiles: [], mismatches: [], checked: 0 };

    // ── ledger ──
    const legacy = readLines(opts.fromLedger);
    const hubdFile = workLedgerFile(roots);
    const hubd = readLines(hubdFile);
    report.skippedMalformedLines = legacy.bad.length;
    const have = new Map<string, number>();
    for (const l of hubd.lines) have.set(l.key, (have.get(l.key) ?? 0) + 1);
    const seen = new Map<string, number>();
    const fresh: Line[] = [];
    for (const l of legacy.lines) {
      const n = (seen.get(l.key) ?? 0) + 1;
      seen.set(l.key, n);
      if (!inScope(l.id)) continue;
      if (n > (have.get(l.key) ?? 0)) fresh.push(l);
    }
    fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // stable (Array.sort): equal timestamps keep legacy order
    report.eventsToAppend = fresh.length;
    // Hubd's file as-is (unparseable lines kept in place at the front would lose position; keep every original line in order).
    const hubdAll = existsSync(hubdFile) ? readFileSync(hubdFile, "utf-8").split("\n").filter((l) => l.trim()) : [];
    const atOf = new Map<string, string>();
    for (const l of hubd.lines) if (!atOf.has(l.text)) atOf.set(l.text, l.at);
    const merged: string[] = [];
    {
      let i = 0, j = 0;
      let lastAt = "";
      while (i < hubdAll.length || j < fresh.length) {
        const hAt = i < hubdAll.length ? (atOf.get(hubdAll[i]!) ?? lastAt) : undefined; // an unparseable hubd line rides with its predecessor
        const takeHubd = j >= fresh.length || (hAt !== undefined && hAt <= fresh[j]!.at);
        if (takeHubd) { merged.push(hubdAll[i]!); lastAt = hAt ?? lastAt; i++; } else { merged.push(fresh[j]!.text); j++; }
      }
    }

    // ── files ──
    const lastDay = (ls: Line[]) => {
      const m = new Map<string, string>();
      for (const l of ls) { const d = l.at.slice(0, 10); if ((m.get(l.id) ?? "") < d) m.set(l.id, d); }
      return m;
    };
    const legacyDay = lastDay(legacy.lines);
    const hubdDay = lastDay(hubd.lines);
    const ledgerFold = foldWork([...hubd.lines, ...legacy.lines].filter((l) => inScope(l.id)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((l) => l.event));
    const writes: Array<{ target: string; data: Buffer; like: string }> = [];
    const legacyStages = new Map<string, { domain: string; stage: string }>();
    for (const d of domains) {
      const src = join(opts.fromDomains, d, "work");
      if (!existsSync(src)) continue;
      const dst = workDir(roots, d);
      for (const f of readdirSync(src).filter((n) => n.endsWith(".md")).sort()) {
        const lf = readWorkFile(join(src, f));
        if (!lf || `${lf.id}.md` !== f || domainOfId(lf.id) !== d) { report.skippedFiles.push(`${d}/${f}`); continue; }
        legacyStages.set(lf.id, { domain: d, stage: lf.stage });
        const target = join(dst, f);
        const hf = existsSync(target) ? readWorkFile(target) : undefined;
        if (!hf) {
          if (existsSync(target)) { report.skippedFiles.push(`${d}/${f} (hubd copy unreadable)`); continue; }
          report.filesToAdd.push(lf.id);
          writes.push({ target, data: lf.raw, like: dst });
          continue;
        }
        if (hf.raw.equals(lf.raw)) continue;
        const lEff = [lf.updated, legacyDay.get(lf.id) ?? ""].sort().pop()!;
        const hEff = [hf.updated, hubdDay.get(hf.id) ?? ""].sort().pop()!;
        let decision: "legacy" | "hubd" | "conflict-kept-hubd" = lEff > hEff ? "legacy" : hEff > lEff ? "hubd" : "conflict-kept-hubd";
        if (decision === "conflict-kept-hubd") {
          // Same age: the merged ledger is the source of truth, so the file that agrees with its folded stage wins; if both or neither do it stays a conflict.
          const folded = (ledgerFold.get(lf.id as never) as { stage?: string } | undefined)?.stage;
          if (folded && folded === lf.stage && folded !== hf.stage) decision = "legacy";
          else if (folded && folded === hf.stage && folded !== lf.stage) decision = "hubd";
        }
        report.decisions.push({ id: lf.id, legacyStage: lf.stage, hubdStage: hf.stage, legacyUpdated: lEff, hubdUpdated: hEff, decision });
        if (decision === "legacy") {
          report.filesToUpdate.push({ id: lf.id, from: hf.stage, to: lf.stage, reason: lEff > hEff ? `legacy ${lEff} > hubd ${hEff}` : `same age ${lEff}; legacy stage matches the ledger` });
          writes.push({ target, data: lf.raw, like: target });
        } else if (decision === "conflict-kept-hubd") report.conflicts.push(lf.id);
      }
    }

    if (dry) return report;
    if (report.eventsToAppend === 0 && writes.length === 0) return finish(report, roots, legacyStages);

    // ── backup, then write ──
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const backupDir = join(opts.dataDir, "backups", `work-import-${stamp}`);
    mkdirSync(join(backupDir, "ledger"), { recursive: true });
    if (existsSync(hubdFile)) cpSync(hubdFile, join(backupDir, "ledger", "work-events.jsonl"), { preserveTimestamps: true });
    for (const d of domains) {
      const dir = workDir(roots, d);
      if (existsSync(dir)) cpSync(dir, join(backupDir, "kb", "base", "domains", d, "work"), { recursive: true, dereference: true, preserveTimestamps: true });
    }
    report.backupDir = backupDir;
    for (const w of writes) {
      mkdirSync(dirname(w.target), { recursive: true });
      atomicPut(w.target, w.data, w.like === dirname(w.target) ? w.like : w.like);
    }
    if (report.eventsToAppend > 0) {
      mkdirSync(dirname(hubdFile), { recursive: true });
      if (!existsSync(hubdFile)) writeFileSync(hubdFile, "");
      atomicPut(hubdFile, merged.join("\n") + "\n", hubdFile);
    }
    return finish(report, roots, legacyStages);
  } finally {
    lock.release();
  }
}

/** Consistency check: the ledger-only fold (hubd's write path) must know every legacy item, and the merged read state must show its legacy stage. */
function finish(report: ImportReport, roots: ReturnType<typeof hubRoots>, legacyStages: Map<string, { domain: string; stage: string }>): ImportReport {
  const ledgerOnly = foldWork(readLines(workLedgerFile(roots)).lines.map((l) => l.event));
  const states = new Map<string, Map<string, { stage: unknown }>>();
  for (const [id, { domain, stage }] of legacyStages) {
    report.checked++;
    if (!states.has(domain)) states.set(domain, loadMergedWorkState(roots, domain));
    const got = states.get(domain)!.get(id);
    if (!got) report.mismatches.push(`${id}: missing from merged state (legacy stage ${stage})`);
    else if (got.stage !== stage) report.mismatches.push(`${id}: merged stage ${String(got.stage)}, legacy file ${stage}`);
    if (!ledgerOnly.has(id as never)) report.mismatches.push(`${id}: unknown to the ledger-only fold (hubd writes would 404)`);
  }
  return report;
}

export function formatReport(r: ImportReport): string[] {
  const out = [
    `hubd work-import${r.dryRun ? " (dry run, nothing written)" : ""}: domains ${r.domains.join(",")}`,
    `events to append: ${r.eventsToAppend}`,
    `files to add: ${r.filesToAdd.length}`,
    `files to update: ${r.filesToUpdate.length}`,
    `conflicts (same age, differing; hubd kept): ${r.conflicts.length}`,
    `skipped malformed ledger lines: ${r.skippedMalformedLines}`,
    `skipped files: ${r.skippedFiles.length}`,
  ];
  for (const f of r.skippedFiles) out.push(`  skipped ${f}`);
  for (const d of r.decisions) out.push(`  both stores ${d.id}: legacy ${d.legacyStage} (${d.legacyUpdated}) vs hubd ${d.hubdStage} (${d.hubdUpdated}) -> ${d.decision}`);
  for (const u of r.filesToUpdate) out.push(`  update ${u.id}: ${u.from} -> ${u.to} (${u.reason})`);
  if (r.backupDir) out.push(`backup: ${r.backupDir}`);
  if (!r.dryRun) {
    out.push(`consistency check: ${r.checked} legacy items, ${r.mismatches.length} mismatch(es)`);
    for (const m of r.mismatches) out.push(`  MISMATCH ${m}`);
  }
  return out;
}
