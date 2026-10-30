/**
 * hubd export / import: one tar of the hub's durable state, with a manifest, so a hub can be moved or restored.
 *
 * INCLUDED (relative to the data dir):
 *   ledger/work-events.jsonl         the work ledger
 *   ledger/events.jsonl              the KB ledger
 *   kb/base/**                       the KB (domains.yaml, domains/<d>/entries + work/*.md, _registry.md, _digest.json, INDEX.md)
 *   kb/ops/contributions/**          contributions incl. _processed and _bad
 *   registry/registry.json           the registry
 * EXCLUDED: run/ (locks, run file, KB commit journal: process state), tmp/ (write scratch), and anything else (e.g. a
 * DEV-SNAPSHOT marker, other kb/ops lanes, other ledger/ files); they are reported in `skipped`.
 *
 * CONSISTENCY: export takes the work-writer lock and the KB-writer lock (the hub's own helpers), so it refuses while a hub runs
 * on the data dir, and no write can interleave with the read. It also refuses if run/kb-commit.journal.json exists (an
 * unrecovered batch): start the hub once so recovery runs, stop it, export.
 *
 * Taking the locks CREATES run/ (and the lock files) in the SOURCE data dir, so export is a write: it fails on a read-only mount.
 * The locks are released again; run/ itself is left behind (it is never exported).
 *
 * lastEventSequence = the number of events the hub's own ledger readers return for the work ledger (readWorkLedger: blank lines
 * and lines that are not valid events are skipped); kbLedgerLines likewise for the KB ledger (readLedger). A ledger whose last
 * line is torn (no trailing newline) is REFUSED: the readers would ignore the tail, so the archive would carry bytes the hub never
 * counted. Fix: cut the partial last line by hand (the hub does not repair a ledger tail), then export. Import recomputes both counts from the archive bytes and refuses a mismatch.
 *
 * IMPORT: the target may not exist (the archive is extracted to a sibling temp dir and renamed into place; the parent must be
 * writable) or may be an existing EMPTY directory (the temp dir is made INSIDE it and its verified contents are moved into the
 * target entry by entry, so the target's own mode, owner and mount point are kept; the target must be writable). Imported files
 * are 0644 and directories 0755, which is what the hub itself creates (kb commits write 0644, ledgers and dirs use the default
 * umask); the tar file itself is 0600 because it holds the whole hub.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { parseWorkEvent } from "@wolfpack/kb/client";
import { KbEventSchema } from "@wolfpack/kb/shared";
import { acquireKbWriterLock, kbJournalFile } from "./kb-commits.js";
import { readTar, writeTar, type TarEntry } from "./tar.js";

export const EXPORT_FORMAT_VERSION = 1;
export const MANIFEST_NAME = "manifest.json";

const WORK_LEDGER = "ledger/work-events.jsonl";
const KB_LEDGER = "ledger/events.jsonl";
const INCLUDE_FILES = [WORK_LEDGER, KB_LEDGER, "registry/registry.json"];
const INCLUDE_TREES = ["kb/base", "kb/ops/contributions"];

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ExportManifest {
  formatVersion: number;
  createdAt: string;
  /** The work ledger line count (the sequence of the last work event). */
  lastEventSequence: number;
  kbLedgerLines: number;
  files: ManifestFile[];
  dirs: string[];
}

export class ExportError extends Error {}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** Event count exactly as the hub's readers see it (readWorkLedger / readLedger): blank lines and unparseable or invalid lines are skipped. */
export function countEvents(b: Buffer | undefined, kind: "work" | "kb"): number {
  if (!b || !b.length) return 0;
  let n = 0;
  for (const line of b.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const json = JSON.parse(line);
      if (kind === "work" ? parseWorkEvent(json) : KbEventSchema.safeParse(json).success) n++;
    } catch {
      /* skipped by the hub's readers too */
    }
  }
  return n;
}

function walk(root: string, rel: string, files: Map<string, Buffer>, dirs: Set<string>): void {
  const abs = join(root, rel);
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) throw new ExportError(`refusing to export a symlink: ${rel}`);
  if (st.isDirectory()) {
    dirs.add(rel);
    for (const n of readdirSync(abs).sort()) walk(root, `${rel}/${n}`, files, dirs);
  } else if (st.isFile()) files.set(rel, readFileSync(abs));
  else throw new ExportError(`refusing to export a special file: ${rel}`);
}

export function exportHub(opts: { dataDir: string; out: string; now?: () => Date }): { manifest: ExportManifest; skipped: string[] } {
  const dataDir = resolve(opts.dataDir);
  const out = resolve(opts.out);
  if (!existsSync(dataDir) || !lstatSync(dataDir).isDirectory()) throw new ExportError(`${dataDir} is not a directory`);
  if (existsSync(out)) throw new ExportError(`${out} already exists; refusing to overwrite`);
  // Compare real paths (the output's parent may be a symlink into the data dir); the output itself does not exist yet.
  let realOutParent: string;
  try {
    realOutParent = realpathSync(dirname(out));
  } catch {
    realOutParent = dirname(out);
  }
  const rel = relative(realpathSync(dataDir), join(realOutParent, basename(out)));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new ExportError("the output file must be outside the data directory");
  let workLock: { release(): void } | undefined;
  let kbLock: { release(): void } | undefined;
  try {
    try {
      workLock = acquireWorkWriterLock(dataDir);
      kbLock = acquireKbWriterLock(dataDir);
    } catch (e) {
      throw new ExportError(`cannot export: a hub (or another writer) holds ${dataDir}; stop it first (${e instanceof Error ? e.message : String(e)})`);
    }
    if (existsSync(kbJournalFile(dataDir)))
      throw new ExportError(`cannot export: ${kbJournalFile(dataDir)} exists (an unrecovered KB commit batch). Start the hub once on this data dir so recovery runs, stop it, then export`);
    const files = new Map<string, Buffer>();
    const dirs = new Set<string>();
    for (const f of [WORK_LEDGER, KB_LEDGER]) {
      const st = lstatSync(join(dataDir, f), { throwIfNoEntry: false });
      if (st?.isFile() && st.size > 0) {
        const fd = readFileSync(join(dataDir, f));
        if (fd[fd.length - 1] !== 0x0a)
          throw new ExportError(`cannot export: ${f} ends in a partial line (no trailing newline), which the hub's reader ignores. Cut the partial last line by hand (the hub does not repair a ledger tail), then export`);
      }
    }
    for (const f of INCLUDE_FILES) walk(dataDir, f, files, dirs);
    for (const t of INCLUDE_TREES) walk(dataDir, t, files, dirs);
    const manifest: ExportManifest = {
      formatVersion: EXPORT_FORMAT_VERSION,
      createdAt: (opts.now?.() ?? new Date()).toISOString(),
      lastEventSequence: countEvents(files.get(WORK_LEDGER), "work"),
      kbLedgerLines: countEvents(files.get(KB_LEDGER), "kb"),
      files: [...files.keys()].sort().map((p) => ({ path: p, size: files.get(p)!.length, sha256: sha(files.get(p)!) })),
      dirs: [...dirs].sort(),
    };
    const entries: TarEntry[] = [{ path: MANIFEST_NAME, type: "file", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }];
    for (const d of manifest.dirs) entries.push({ path: d, type: "dir", data: Buffer.alloc(0) });
    for (const f of manifest.files) entries.push({ path: f.path, type: "file", data: files.get(f.path)! });
    const tar = writeTar(entries);
    mkdirSync(dirname(out), { recursive: true });
    const tmp = `${out}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmp, tar, { flag: "wx", mode: 0o600 });
      chmodSync(tmp, 0o600);
      try {
        linkSync(tmp, out); // no-clobber: EEXIST if --out appeared since the check above
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ExportError(`${out} already exists; refusing to overwrite`);
        throw e;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    const skipped: string[] = [];
    const known = (p: string) => INCLUDE_FILES.includes(p) || INCLUDE_TREES.some((t) => p === t || t.startsWith(p + "/") || p.startsWith(t + "/")) || ["kb", "kb/ops", "ledger", "registry"].includes(p);
    const scan = (r: string) => {
      for (const n of readdirSync(join(dataDir, r))) {
        const p = r ? `${r}/${n}` : n;
        if (known(p)) {
          if (lstatSync(join(dataDir, p)).isDirectory() && !INCLUDE_TREES.some((t) => p === t || p.startsWith(t + "/"))) scan(p);
        } else skipped.push(p);
      }
    };
    scan("");
    return { manifest, skipped: skipped.sort() };
  } finally {
    kbLock?.release();
    workLock?.release();
  }
}

const allowedPath = (p: string): boolean => INCLUDE_FILES.includes(p) || INCLUDE_TREES.some((t) => p === t || p.startsWith(t + "/"));
const dirAllowed = (p: string): boolean => allowedPath(p) || ["kb", "kb/ops", "ledger", "registry"].includes(p);

function safePath(p: string): string {
  if (!p || isAbsolute(p) || p.startsWith("/") || p.includes("\\") || p.includes("\0")) throw new ExportError(`unsafe path in archive: ${JSON.stringify(p.slice(0, 80))}`);
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) throw new ExportError(`unsafe path in archive: ${JSON.stringify(p.slice(0, 80))}`);
  return p;
}

function parseManifest(data: Buffer): ExportManifest {
  let m: ExportManifest;
  try {
    m = JSON.parse(data.toString("utf8"));
  } catch {
    throw new ExportError("manifest.json is not valid JSON");
  }
  if (!m || typeof m !== "object") throw new ExportError("manifest.json is malformed");
  if (m.formatVersion !== EXPORT_FORMAT_VERSION) throw new ExportError(`unsupported export formatVersion ${JSON.stringify(m.formatVersion)} (this hubd reads ${EXPORT_FORMAT_VERSION})`);
  const ok =
    Number.isInteger(m.lastEventSequence) && Number.isInteger(m.kbLedgerLines) && typeof m.createdAt === "string" && Array.isArray(m.files) && Array.isArray(m.dirs) &&
    m.files.every((f) => f && typeof f.path === "string" && Number.isInteger(f.size) && typeof f.sha256 === "string") && m.dirs.every((d) => typeof d === "string");
  if (!ok) throw new ExportError("manifest.json is malformed");
  return m;
}

function targetState(target: string): void {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return;
  if (!st.isDirectory()) throw new ExportError(`${target} exists and is not a directory`);
  if (readdirSync(target).length > 0) throw new ExportError(`${target} is not empty; refusing to import over existing data`);
}

/** Verifies the whole archive first (manifest, paths, listing, sizes, hashes, ledger line counts), then extracts into a sibling temp dir and renames it into place. */
export function importHub(opts: { dataDir: string; in: string }): ExportManifest {
  const target = resolve(opts.dataDir);
  targetState(target);
  const entries = readTar(readFileSync(opts.in));
  const first = entries[0];
  if (!first || first.path !== MANIFEST_NAME || first.type !== "file") throw new ExportError("the first tar entry must be manifest.json");
  const manifest = parseManifest(first.data);
  const listedFiles = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    safePath(f.path);
    if (!allowedPath(f.path) || listedFiles.has(f.path)) throw new ExportError(`manifest lists a disallowed or duplicate file: ${f.path}`);
    listedFiles.set(f.path, f);
  }
  const listedDirs = new Set<string>();
  for (const d of manifest.dirs) {
    safePath(d);
    if (!dirAllowed(d) || listedDirs.has(d)) throw new ExportError(`manifest lists a disallowed or duplicate dir: ${d}`);
    listedDirs.add(d);
  }
  const seen = new Set<string>();
  const data = new Map<string, Buffer>();
  for (const e of entries.slice(1)) {
    safePath(e.path);
    if (seen.has(e.path)) throw new ExportError(`duplicate archive entry: ${e.path}`);
    seen.add(e.path);
    if (e.type === "dir") {
      if (!listedDirs.has(e.path)) throw new ExportError(`archive entry not in the manifest: ${e.path}`);
      continue;
    }
    const f = listedFiles.get(e.path);
    if (!f) throw new ExportError(`archive entry not in the manifest: ${e.path}`);
    if (e.data.length !== f.size) throw new ExportError(`size mismatch for ${e.path}`);
    if (sha(e.data) !== f.sha256) throw new ExportError(`hash mismatch for ${e.path}`);
    data.set(e.path, e.data);
  }
  for (const p of [...listedFiles.keys(), ...listedDirs]) if (!seen.has(p)) throw new ExportError(`manifest entry missing from the archive: ${p}`);
  if (countEvents(data.get(WORK_LEDGER), "work") !== manifest.lastEventSequence) throw new ExportError("work ledger line count does not match the manifest lastEventSequence");
  if (countEvents(data.get(KB_LEDGER), "kb") !== manifest.kbLedgerLines) throw new ExportError("KB ledger line count does not match the manifest");

  const existing = existsSync(target);
  if (!existing) mkdirSync(dirname(target), { recursive: true });
  // Existing empty target: scratch INSIDE it (same filesystem even for a mount point), then move entries up. Otherwise a sibling.
  const tmp = existing ? join(target, `.import-${randomBytes(4).toString("hex")}`) : `${target}.import-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(tmp, { mode: DIR_MODE });
    for (const d of manifest.dirs) {
      mkdirSync(join(tmp, d), { recursive: true, mode: DIR_MODE });
      chmodSync(join(tmp, d), DIR_MODE);
    }
    for (const [p, b] of data) {
      const abs = join(tmp, p);
      if (!abs.startsWith(tmp + sep)) throw new ExportError(`unsafe path in archive: ${p}`);
      mkdirSync(dirname(abs), { recursive: true, mode: DIR_MODE });
      writeFileSync(abs, b, { flag: "wx", mode: FILE_MODE });
      chmodSync(abs, FILE_MODE);
    }
    chmodSync(tmp, DIR_MODE);
    if (existing) {
      const now = readdirSync(target);
      if (now.length !== 1 || now[0] !== basename(tmp)) throw new ExportError(`${target} changed during import; refusing`);
      const moved: string[] = [];
      try {
        for (const n of readdirSync(tmp)) {
          renameSync(join(tmp, n), join(target, n));
          moved.push(n);
        }
      } catch (e) {
        for (const n of moved) rmSync(join(target, n), { recursive: true, force: true }); // leave the target empty again
        throw e;
      }
      rmSync(tmp, { recursive: true, force: true });
    } else {
      targetState(target); // re-check: nothing may have appeared meanwhile
      renameSync(tmp, target);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return manifest;
}
