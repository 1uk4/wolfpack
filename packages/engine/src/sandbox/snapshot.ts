/**
 * Snapshot: copy a wolfpack host's work ledger, contributions lanes and one wolf's den into a dev root
 * (layout.ts). READ-ONLY on the source; every write lands under `devRoot`.
 *
 * Each source part is either a local path or a remote spec `[user@]host:/abs/path` (fetched with rsync over ssh).
 * Tests and local dev use local paths; the remote variant exists for sfo-01 and is never exercised in CI.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPathLoose } from "./resolve.js";
import { sandboxPaths, SNAPSHOT_MANIFEST, wolfDenDir, type SandboxPaths } from "./layout.js";
import { liveWorkWriterPid } from "./work-writer.js";

export interface SnapshotSource {
  /** Dir holding `ledger/work-events.jsonl` (sfo-01: /var/wolfpack/kb/work). */
  workDir: string;
  /** Dir holding `domains/<d>/work/*.md` (sfo-01: /var/wolfpack/kb/base). Optional: the ledger alone is enough. */
  workBaseDir?: string;
  /** KB ops root with `inbox|receipts|parked/<wolf>` (sfo-01: /var/wolfpack/kb/ops). Absent: the sandbox starts with empty lanes. */
  opsDir?: string;
  /** Copy only these wolves' lanes (`inbox|receipts|parked/<lane>`) of a LOCAL opsDir. Absent: every lane. */
  opsLanes?: string[];
  /** The wolf's den (sfo-01: /home/wolf-<id>/den). */
  denDir: string;
  /**
   * A KB base to COPY (read-only source) into `<root>/kb-base`: the sandbox then runs with KB_BASE there and a librarian
   * may be enabled on it. LOCAL path only (a remote KB is never pulled). `domains/<d>/work/` is left out: the work
   * server owns the item files.
   */
  kbBaseDir?: string;
}

export interface SnapshotOptions {
  source: SnapshotSource;
  devRoot: string;
  /** Replace a previous snapshot (only dirs that carry a snapshot manifest are ever replaced). */
  force?: boolean;
  /**
   * Include session.sqlite (+ wal/shm, backups) TOGETHER with the conversation-keyed den state that refers to its
   * conversation ids (bindings, pool, watermarks). Off (default): a live sqlite copy is inconsistent and large, and
   * that state is meaningless without it, so it is dropped too (see DEN_STATE_EXCLUDES).
   */
  includeSessions?: boolean;
  /** ssh identity file for remote parts. */
  sshIdentity?: string;
  /** Shared layout: the den lands in `<root>/dens/<denName>` (several wolves share one root) instead of `<root>/den`. */
  denName?: string;
  /**
   * Refresh ONLY the work ledger + work item files of an existing snapshot (the one remote part), leaving dens, ops and
   * the KB copy alone. The previous ledger/items are moved aside, never deleted.
   */
  workOnly?: boolean;
  /** Paths the dev root must not overlap (live KB, Syncthing folders, other wolves' homes...). Checked both ways. */
  forbiddenRoots?: string[];
  /** Fail (installing nothing) when the ledger has events but no work item .md file was copied. */
  requireWorkItems?: boolean;
  /** Proceed despite an `.install-in-progress` marker from an earlier failed install (after you restored the named parts). */
  recover?: boolean;
  /** Test seams (no production caller): run right before the live-writer re-check, and after each installed part. */
  hooks?: { beforeInstall?: () => void; afterStep?: (rel: string) => void };
  /** Test seam: the process spawner for rsync/ssh. Default: child_process.spawnSync. */
  runner?: Runner;
  now?: () => Date;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export interface Runner {
  rsync(argv: string[]): RunResult;
  ssh(argv: string[]): RunResult;
}
export const defaultRunner: Runner = {
  rsync: (argv) => run("rsync", argv),
  ssh: (argv) => run("ssh", argv),
};
function run(cmd: string, argv: string[]): RunResult {
  const r = spawnSync(cmd, argv, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
}

export interface WorkCrossCheck {
  ledgerIds: number;
  mdFiles: number;
  /** Ledger ids with no .md file. */
  missingMd: string[];
  /** .md files whose id the ledger never mentions. */
  missingLedger: string[];
}

/** Compare the work ids the ledger references (`id` of each event) with the item files under `<workBase>/domains/<d>/work/`. */
export function crossCheckWork(ledgerFile: string, workBase: string): WorkCrossCheck {
  const ids = new Set<string>();
  if (existsSync(ledgerFile)) {
    for (const line of readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id === "string" && id.startsWith("work-")) ids.add(id);
      } catch { /* torn/garbage line */ }
    }
  }
  const md = new Set(walkFiles(join(workBase, "domains")).filter((f) => f.endsWith(".md")).map((f) => f.slice(f.lastIndexOf(sep) + 1, -3)));
  return {
    ledgerIds: ids.size,
    mdFiles: md.size,
    missingMd: [...ids].filter((i) => !md.has(i)).sort(),
    missingLedger: [...md].filter((i) => !ids.has(i)).sort(),
  };
}

export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  source: SnapshotSource;
  counts: { ledgerEvents: number; workItems: number; opsFiles: number; denFiles: number; kbBaseFiles: number };
  /** Where the den was copied to, relative to the root (`den` or `dens/<wolf>`). */
  den: string;
  /** sha256 of the ledger file as installed. For a remote ledger it equals the remote hash taken BEFORE the copy (the snapshot fails otherwise). */
  ledgerSha256?: string;
  includeSessions: boolean;
  /** Den paths (relative to the den root; trailing * = prefix) left out of this snapshot. */
  excluded: string[];
}

/** `host:/path` or `user@host:/path`; anything starting with / . ~ is a local path. */
export function isRemoteSpec(spec: string): boolean {
  if (/^[/.~]/.test(spec)) return false;
  return /^(?:[\w.-]+@)?[\w.-]+:[^\\]/.test(spec);
}

const SESSION_EXCLUDES = ["session.sqlite*", "session-backups", "backups"];

/**
 * Den state keyed by conversation ids or fed from the live observation pool. Conversation ids are meaningless once
 * session.sqlite is gone (the sandbox's fresh conversation 1 would inherit a live work binding and pool), so these are
 * dropped with it. `.memory/sessions/` (per-wolf session topics) is NOT conversation-keyed and stays.
 */
export const DEN_STATE_EXCLUDES = ["factory/conversations", "tasks/active.json*", ".memory/pool", ".memory/watermarks"];

/**
 * Never copied, with or without sessions: the host's deployed extension bundles. They are built for the host's checkout
 * and can predate this one (a stale memory bundle leaves the feature inert); the CLI installs current ones instead
 * (`wolfpack sandbox install-extensions`).
 */
export const DEN_BUNDLE_EXCLUDES = ["extensions"];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function matchesExclude(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** Den filter: session stores match on the top-level name; state paths match the whole relative path (dirs prune their subtree). */
function denExcluded(rel: string, sessionExcludes: string[], stateExcludes: string[]): boolean {
  const posix = rel.split(sep).join("/");
  return matchesExclude(posix.split("/")[0], sessionExcludes) || matchesExclude(posix, stateExcludes);
}

/** Copy a tree, never following symlinks out of it (links are skipped). `filter` sees paths relative to src. */
function copyLocal(src: string, dest: string, filter: (rel: string, isDir: boolean) => boolean): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      const rel = relative(src, from);
      if (rel === "") return true;
      const st = lstatSync(from, { throwIfNoEntry: false });
      if (!st || !(st.isDirectory() || st.isFile())) return false; // skip symlinks/sockets
      return filter(rel, st.isDirectory());
    },
  });
}

/** ssh options shared by the rsync transport and the read-only hash command. Key only, never a desktop ssh-agent. */
export function sshArgs(identity?: string): string[] {
  const base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  if (identity) base.push("-i", identity, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none");
  return base;
}

/** ssh transport for rsync -e. The identity is one argv element, quoted for rsync's own re-splitting. */
export function sshCommand(identity?: string): string {
  const quoted = sshArgs(identity).map((a) => (a === identity ? `'${a.replace(/'/g, `'\\''`)}'` : a));
  return ["ssh", ...quoted].join(" ");
}

/**
 * Pure: the exact rsync argv for one remote part. `--` guards against a spec starting with `-`. The remote spec is the
 * SOURCE and the local dir the destination; there is no --delete and nothing is ever written to the remote side.
 * `dryRun` adds `-n --itemize-changes` (lists what would be copied, copies nothing).
 */
export function rsyncArgv(spec: string, dest: string, rules: string[], identity?: string, opts: { local?: boolean; dryRun?: boolean } = {}): string[] {
  if (!opts.local && isRemoteSpec(spec)) assertSafeRemoteSpec(spec.replace(/\/+$/, ""));
  return [
    "-a", "--no-links",
    ...(opts.dryRun ? ["-n", "--itemize-changes"] : []),
    ...(opts.local ? [] : ["-e", sshCommand(identity)]),
    ...rules, "--", `${spec.replace(/\/+$/, "")}/`, `${dest.replace(/\/+$/, "")}/`,
  ];
}

/** Host and path of a remote spec are used verbatim in argv: only conservative characters, and never a leading `-`. */
export function assertSafeRemoteSpec(spec: string): void {
  const { host, path } = splitRemote(spec);
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) throw new Error(`snapshot: unsafe host in remote spec '${spec}' (letters, digits, . _ - and an optional user@; no leading '-')`);
  if (!/^[\w./-]+$/.test(path) || path.includes("..")) throw new Error(`snapshot: unsafe remote path in '${spec}' (only [A-Za-z0-9_./-], no '..')`);
}

/**
 * ALLOW-list of exactly the rsync flags this module builds: `-a --no-links [-n --itemize-changes] [-e "ssh ..."]
 * --include=<rule> --exclude=<rule> -- <source> <dest>`. Anything else (--delete*, --remove-source-files, --rsync-path,
 * --files-from, --daemon, any unknown short flag...) is refused before spawning, whoever built the argv. The remote spec is
 * the source, the destination is local.
 */
export function assertReadOnlyRsyncArgv(argv: string[]): void {
  const sepAt = argv.indexOf("--");
  if (sepAt < 0 || argv.length !== sepAt + 3) throw new Error("snapshot: rsync argv must end with `-- <source> <dest>`");
  const [source, dest] = argv.slice(sepAt + 1);
  const flags = argv.slice(0, sepAt);
  let remote = false;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "-a" || f === "--no-links" || f === "-n" || f === "--itemize-changes") continue;
    if (f === "-e") {
      const cmd = flags[++i];
      if (cmd === undefined || !/^ssh /.test(cmd)) throw new Error("snapshot: rsync -e must be an `ssh ...` command");
      remote = true;
      continue;
    }
    if (/^--(include|exclude)=./.test(f)) continue;
    throw new Error(`snapshot: refusing rsync flag ${f} (not on the allow-list; the remote is read-only)`);
  }
  if (isRemoteSpec(dest)) throw new Error(`snapshot: rsync destination ${dest} must be local`);
  if (remote) {
    if (!isRemoteSpec(source)) throw new Error(`snapshot: rsync source ${source} must be the remote spec`);
    assertSafeRemoteSpec(source.replace(/\/$/, ""));
  } else if (isRemoteSpec(source)) {
    throw new Error(`snapshot: rsync source ${source} is remote but no ssh transport was given`);
  }
}

/** Filter rules per part; `ledger` copies <src>/ledger/work-events.jsonl into <dest>/ledger/. */
export const RSYNC_RULES = {
  ledger: ["--include=/ledger/", "--include=/ledger/work-events.jsonl", "--exclude=*"],
  workMd: ["--include=/domains/", "--include=/domains/*/", "--include=/domains/*/work/", "--include=/domains/*/work/*.md", "--exclude=*"],
  /** Anchored to the den root, so a same-named path deeper in the tree is untouched. */
  denState: [...DEN_STATE_EXCLUDES, ...DEN_BUNDLE_EXCLUDES].map((e) => `--exclude=/${e}`),
  ops: ["--include=/inbox/", "--include=/inbox/**", "--include=/receipts/", "--include=/receipts/**", "--include=/parked/", "--include=/parked/**", "--exclude=*"],
} as const;

/** @internal `local` runs rsync's local mode (no ssh) so tests can prove the filters on a plain directory. */
export function copyRemote(spec: string, dest: string, rules: string[], identity?: string, opts: { local?: boolean; runner?: Runner } = {}): void {
  mkdirSync(dest, { recursive: true });
  const argv = rsyncArgv(spec, dest, rules, identity, opts);
  assertReadOnlyRsyncArgv(argv);
  const r = (opts.runner ?? defaultRunner).rsync(argv);
  if (r.status !== 0) throw new Error(`rsync from ${spec} failed (${r.status}): ${r.stderr.trim().split("\n")[0]}`);
}

/** `[user@]host:/abs/path` -> the ssh destination and the path on it. */
export function splitRemote(spec: string): { host: string; path: string } {
  const i = spec.indexOf(":");
  return { host: spec.slice(0, i), path: spec.slice(i + 1) };
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The read-only ssh argv that hashes one remote file: `sha256sum -- <file>` and nothing else. */
export function remoteSha256Argv(spec: string, identity?: string): string[] {
  assertSafeRemoteSpec(spec);
  const { host, path } = splitRemote(spec);
  return [...sshArgs(identity), host, `sha256sum -- ${shq(path)}`];
}

export function parseSha256sum(stdout: string): string {
  const m = stdout.trim().match(/^([0-9a-f]{64})\s/);
  if (!m) throw new Error(`snapshot: unexpected sha256sum output: ${stdout.trim().slice(0, 80)}`);
  return m[1];
}

export function remoteSha256(spec: string, identity: string | undefined, runner: Runner = defaultRunner): string {
  const r = runner.ssh(remoteSha256Argv(spec, identity));
  if (r.status !== 0) throw new Error(`snapshot: could not hash remote ${spec} (${r.status}): ${r.stderr.trim().split("\n")[0]}`);
  return parseSha256sum(r.stdout);
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Shell-pasteable display of an argv (display only; the real argv is never joined into a shell string). */
export function formatCommand(cmd: string, argv: string[]): string {
  const q = (a: string) => (!/[\s'*<>]/.test(a) ? a : a.includes("'") ? `"${a}"` : `'${a}'`);
  return [cmd, ...argv.map(q)].join(" ");
}

export interface PlanStep {
  label: string;
  cmd: "ssh" | "rsync";
  argv: string[];
  command: string;
}

/** Where the plan says rsync writes: the staging dir takeSnapshot really uses is `<dev-root>/.staging-<timestamp>`. */
export const PLAN_DEST = "<dev-root>/.staging-<timestamp>";

/**
 * The remote commands a snapshot of `source` would run, nothing executed (for review before anyone approves). Built by the
 * same functions takeSnapshot calls, so what is printed is what runs (with `dest` = the real staging dir).
 */
export function remotePlan(source: SnapshotSource, identity?: string, dest: string = PLAN_DEST): PlanStep[] {
  const plan: PlanStep[] = [];
  const add = (label: string, cmd: "ssh" | "rsync", argv: string[]) => plan.push({ label, cmd, argv, command: formatCommand(cmd, argv) });
  const hashSpec = isRemoteSpec(source.workDir) ? `${source.workDir.replace(/\/+$/, "")}/ledger/work-events.jsonl` : "";
  if (hashSpec) add("ledger hash (before)", "ssh", remoteSha256Argv(hashSpec, identity));
  const part = (label: string, spec: string | undefined, rules: readonly string[]) => {
    if (spec && isRemoteSpec(spec)) add(label, "rsync", rsyncArgv(spec, dest, [...rules], identity));
  };
  part("ledger", source.workDir, RSYNC_RULES.ledger);
  part("work items", source.workBaseDir, RSYNC_RULES.workMd);
  if (hashSpec) add("ledger hash (after)", "ssh", remoteSha256Argv(hashSpec, identity));
  return plan;
}

/**
 * `--dry-run`: run `rsync -n --itemize-changes` for each remote part into a throwaway dir and return what it lists.
 * Copies nothing, hashes nothing, writes nothing under any dev root.
 */
export function dryRunRemote(source: SnapshotSource, identity?: string, runner: Runner = defaultRunner): { label: string; lines: string[] }[] {
  const tmp = mkdtempSync(join(tmpdir(), "snapshot-dry-"));
  try {
    const out: { label: string; lines: string[] }[] = [];
    const part = (label: string, spec: string | undefined, rules: readonly string[]) => {
      if (!spec || !isRemoteSpec(spec)) return;
      const argv = rsyncArgv(spec, tmp, [...rules], identity, { dryRun: true });
      assertReadOnlyRsyncArgv(argv);
      const r = runner.rsync(argv);
      if (r.status !== 0) throw new Error(`rsync -n from ${spec} failed (${r.status}): ${r.stderr.trim().split("\n")[0]}`);
      out.push({ label, lines: r.stdout.split("\n").filter((l) => l.trim()) });
    };
    part("ledger", source.workDir, RSYNC_RULES.ledger);
    part("work items", source.workBaseDir, RSYNC_RULES.workMd);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // our own mkdtemp dir, always empty after a dry run
  }
}

/** The librarian's den-local state worth carrying to a sandbox librarian: the KB ledger, vectors, sections and bookkeeping (no backups). */
const LIBRARIAN_STATE = ["ledger/events.jsonl", "vectors", "sections", "emitted.json", "sweep-attempts.json"];

/**
 * Seed a sandbox librarian's den-local KB state (`<den>/kb`) from a real librarian's den (read-only source), so a sweep
 * on the KB copy finds the ledger that describes it instead of a KB with no history. Never overwrites: refuses when the
 * destination already has a ledger. Returns the files copied.
 */
export function seedLibrarianState(srcDen: string, destDen: string): number {
  const src = join(srcDen, "kb");
  const dest = join(destDen, "kb");
  if (!existsSync(join(src, "ledger", "events.jsonl"))) throw new Error(`seed: ${src} has no ledger/events.jsonl (not a librarian den?)`);
  if (existsSync(join(dest, "ledger", "events.jsonl"))) throw new Error(`seed: ${dest} already has a KB ledger; refusing to overwrite`);
  const overlap = (a: string, b: string) => insideOrEqual(realPathLoose(a), realPathLoose(b)) || insideOrEqual(realPathLoose(b), realPathLoose(a));
  if (overlap(src, dest)) throw new Error("seed: source and destination overlap");
  let n = 0;
  for (const rel of LIBRARIAN_STATE) {
    const from = join(src, rel);
    if (!existsSync(from)) continue;
    const st = lstatSync(from);
    if (st.isDirectory()) {
      copyLocal(from, join(dest, rel), () => true);
      n += walkFiles(join(dest, rel)).length;
    } else if (st.isFile()) {
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      cpSync(from, join(dest, rel), { dereference: false });
      n++;
    }
  }
  return n;
}

function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse a dev root that overlaps any local source (snapshotting into the live tree would be the whole bug). */
function assertDisjoint(devRoot: string, source: SnapshotSource, forbidden: string[] = []): void {
  const root = realPathLoose(devRoot);
  for (const [label, spec] of Object.entries(source)) {
    if (typeof spec !== "string" || !spec || isRemoteSpec(spec)) continue;
    const s = realPathLoose(spec);
    if (insideOrEqual(s, root) || insideOrEqual(root, s)) {
      throw new Error(`snapshot: dev root ${devRoot} overlaps source ${label} ${spec}`);
    }
  }
  assertNotProtected(devRoot, forbidden);
}

/** Throw when `devRoot` is inside, equal to, or contains any `forbidden` path (empty entries are ignored). */
export function assertNotProtected(devRoot: string, forbidden: string[]): void {
  const root = realPathLoose(devRoot);
  for (const f of forbidden) {
    if (!f) continue;
    const real = realPathLoose(f);
    if (insideOrEqual(real, root) || insideOrEqual(root, real)) {
      throw new Error(`snapshot: dev root ${devRoot} overlaps protected/synced path ${f}`);
    }
  }
}

/** Drop a torn trailing line (the live ledger may have been mid-append when copied). */
function trimTornLine(file: string): number {
  if (!existsSync(file)) return 0;
  let text = readFileSync(file, "utf8");
  if (text.length && !text.endsWith("\n")) {
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    writeFileSync(file, text);
  }
  return text.split("\n").filter((l) => l.trim()).length;
}

const STAGING = /^\.(staging|replaced|failed)-/;
export const INSTALL_MARKER = ".install-in-progress";

/** KB copy filter: everything except the work item files (the work server's) and OS litter. */
function kbCopyExcluded(rel: string): boolean {
  const parts = rel.split(sep);
  return parts.includes(".DS_Store") || parts.includes("sweep.lock") || (parts[0] === "domains" && parts[2] === "work");
}

/** Move `from` to `<aside>/<name>`; nothing is ever deleted by a re-snapshot. */
function moveAside(from: string, aside: string): void {
  if (!existsSync(from)) return;
  mkdirSync(aside, { recursive: true });
  renameSync(from, join(aside, relative(resolve(from, ".."), from)));
}

export function takeSnapshot(opts: SnapshotOptions): SnapshotManifest & { paths: SandboxPaths } {
  const { source } = opts;
  const devRoot = resolve(opts.devRoot);
  const paths = sandboxPaths(devRoot);
  const runner = opts.runner ?? defaultRunner;
  assertDisjoint(devRoot, source, opts.forbiddenRoots);
  if (source.kbBaseDir && isRemoteSpec(source.kbBaseDir)) throw new Error("snapshot: the KB base is only copied from a local path (never pulled from a host)");
  for (const spec of [source.workDir, source.workBaseDir, source.opsDir, source.denDir]) if (spec && isRemoteSpec(spec)) assertSafeRemoteSpec(spec.replace(/\/+$/, ""));
  const markerFile = join(devRoot, INSTALL_MARKER);
  if (existsSync(markerFile) && !opts.recover) {
    throw new Error(`snapshot: an earlier install in ${devRoot} did not finish (${markerFile}). Restore the parts it names (nothing was deleted: they are under its .replaced-* dir), remove the marker, or re-run with --recover.\n${readFileSync(markerFile, "utf8")}`);
  }
  if (opts.workOnly && !existsSync(paths.manifest)) throw new Error(`snapshot: ${devRoot} is not a snapshot; nothing to refresh`);

  const existing = existsSync(devRoot) ? readdirSync(devRoot).filter((n) => !STAGING.test(n) && n !== INSTALL_MARKER) : [];
  const replacing = existing.length > 0 && !opts.workOnly;
  if (replacing) {
    if (!existsSync(paths.manifest)) throw new Error(`snapshot: ${devRoot} exists, is not empty and is not a snapshot; refusing`);
    if (!opts.force) throw new Error(`snapshot: ${devRoot} already holds a snapshot (use force to replace)`);
  }
  if (existing.length > 0) {
    // The ledger copy has exactly one writer (the local work server); swapping it under that process would corrupt it.
    const live = liveWorkWriterPid(devRoot);
    if (live) throw new Error(`snapshot: the sandbox work server is running (pid ${live}); stop the dev stack before replacing the ledger`);
  }
  mkdirSync(devRoot, { recursive: true });

  // Everything is copied and verified in a staging dir first; only a fully verified snapshot is moved into place, so a
  // failed or mismatching run leaves the previous snapshot untouched (and nothing half-written at the real paths).
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const stage = join(devRoot, `.staging-${stamp}`);
  rmSync(stage, { recursive: true, force: true }); // only ever our own staging dir of the same timestamp
  const sp = sandboxPaths(stage);
  const denRel = opts.denName ? wolfDenDir("", opts.denName) : "den";
  const stagedDen = join(stage, denRel);
  const finalDen = join(devRoot, denRel);

  const sessionExcludes = opts.includeSessions ? [] : SESSION_EXCLUDES;
  const stateExcludes = [...(opts.includeSessions ? [] : DEN_STATE_EXCLUDES), ...DEN_BUNDLE_EXCLUDES];
  const ledgerRel = (rel: string, _isDir?: boolean) => rel === "ledger" || rel === join("ledger", "work-events.jsonl");
  const isWorkMd = (rel: string, isDir: boolean) => {
    const parts = rel.split(sep);
    if (isDir) return parts.length < 3 || (parts[0] === "domains" && (parts.length === 2 || parts[2] === "work"));
    return parts[0] === "domains" && parts[2] === "work" && rel.endsWith(".md");
  };
  const lanes = source.opsLanes;
  const opsLane = (rel: string) => {
    const [kind, lane] = rel.split(sep);
    return ["inbox", "receipts", "parked"].includes(kind) && (!lanes || lane === undefined || lanes.includes(lane));
  };

  // ── work ledger + items (the only parts that may be remote) ───────────────
  const remoteLedger = isRemoteSpec(source.workDir);
  const remoteLedgerFile = remoteLedger ? `${source.workDir.replace(/\/$/, "")}/ledger/work-events.jsonl` : "";
  const hashBefore = remoteLedger ? remoteSha256(remoteLedgerFile, opts.sshIdentity, runner) : undefined;
  if (remoteLedger) copyRemote(source.workDir, stage, [...RSYNC_RULES.ledger], opts.sshIdentity, { runner });
  else copyLocal(source.workDir, stage, ledgerRel);
  if (source.workBaseDir) {
    if (isRemoteSpec(source.workBaseDir)) copyRemote(source.workBaseDir, sp.workBase, [...RSYNC_RULES.workMd], opts.sshIdentity, { runner });
    else copyLocal(source.workBaseDir, sp.workBase, isWorkMd);
  }
  mkdirSync(join(stage, "ledger"), { recursive: true });
  if (!existsSync(sp.ledgerFile)) writeFileSync(sp.ledgerFile, "");
  const copiedSha = sha256File(sp.ledgerFile);
  if (remoteLedger) {
    // Verify BEFORE trusting the copy: the file we hold must be exactly the file the host had before we copied, and the
    // host's file must not have moved while we copied (a live append would make the copy a torn mix).
    const hashAfter = remoteSha256(remoteLedgerFile, opts.sshIdentity, runner);
    if (copiedSha !== hashBefore) throw new Error(`snapshot: copied ledger sha256 ${copiedSha} != remote ${hashBefore} taken before the copy; nothing was installed (staging kept in ${stage})`);
    if (hashAfter !== hashBefore) throw new Error(`snapshot: the remote ledger changed during the snapshot (sha256 ${hashBefore} -> ${hashAfter}); nothing was installed, re-run (staging kept in ${stage})`);
  }
  // A torn line is never valid JSON; an empty ledger must still exist so the work server starts clean.
  if (remoteLedger && trimTornLine(sp.ledgerFile) === 0) {
    throw new Error(`snapshot: remote ledger ${source.workDir} yielded 0 events (wrong path or filter?); refusing a silent empty snapshot`);
  }

  if (opts.requireWorkItems && trimTornLine(sp.ledgerFile) > 0 && walkFiles(join(sp.workBase, "domains")).filter((f) => f.endsWith(".md")).length === 0) {
    throw new Error(`snapshot: the ledger has events but 0 work item .md files were found (work-md source ${source.workBaseDir ?? "none"}); nothing was installed (staging kept in ${stage})`);
  }

  // ── the rest (local only) ─────────────────────────────────────────────────
  if (!opts.workOnly) {
    if (source.opsDir) {
      if (isRemoteSpec(source.opsDir)) copyRemote(source.opsDir, sp.kbOps, [...RSYNC_RULES.ops], opts.sshIdentity, { runner });
      else copyLocal(source.opsDir, sp.kbOps, opsLane);
    }
    if (isRemoteSpec(source.denDir)) {
      copyRemote(source.denDir, stagedDen, [...stateExcludes.map((e) => `--exclude=/${e}`), ...sessionExcludes.map((e) => `--exclude=${e}`)], opts.sshIdentity, { runner });
    } else {
      copyLocal(source.denDir, stagedDen, (rel) => !denExcluded(rel, sessionExcludes, stateExcludes));
    }
    if (source.kbBaseDir) copyLocal(source.kbBaseDir, sp.kbBase, (rel) => !kbCopyExcluded(rel));
    mkdirSync(sp.kbOps, { recursive: true });
    mkdirSync(stagedDen, { recursive: true });
  }

  // ── install: move the previous parts aside (never delete), then the verified ones into place ──
  const aside = join(devRoot, `.replaced-${stamp}`);
  const parts: [string, string][] = opts.workOnly
    ? [["ledger", join(devRoot, "ledger")], ["base", paths.workBase]]
    : [["ledger", join(devRoot, "ledger")], ["base", paths.workBase], ["ops", paths.kbOps], [denRel, finalDen], ["kb-base", paths.kbBase]];
  const prev = opts.workOnly ? ({ den: "den", ...JSON.parse(readFileSync(paths.manifest, "utf8")) } as SnapshotManifest) : undefined;

  // The writer can have started since the first check (the copy above takes a while): re-check, by lock pid AND run file,
  // immediately before anything is moved.
  opts.hooks?.beforeInstall?.();
  const writer = liveWorkWriterPid(devRoot);
  if (writer) throw new Error(`snapshot: the sandbox work server started during the snapshot (pid ${writer}); nothing was installed (staging kept in ${stage})`);

  const plan = parts
    .filter(([rel]) => existsSync(join(stage, rel)))
    .map(([rel, finalPath]) => ({ rel, staged: join(stage, rel), final: finalPath, aside: join(aside, relative(devRoot, finalPath)) }));
  const manifestAside = join(aside, "snapshot.json");
  writeFileSync(markerFile, JSON.stringify({ startedAt: new Date().toISOString(), stage, aside, plan, manifestAside, manifest: paths.manifest }, null, 2) + "\n");
  try {
    for (const step of plan) {
      if (existsSync(step.final)) moveAside(step.final, join(aside, relative(devRoot, resolve(step.final, ".."))));
      mkdirSync(resolve(step.final, ".."), { recursive: true });
      renameSync(step.staged, step.final);
      opts.hooks?.afterStep?.(step.rel);
    }
    if (existsSync(paths.manifest)) moveAside(paths.manifest, aside);
  } catch (e) {
    const fix = [
      ...plan.flatMap((st) => [
        `  [ -e '${st.aside}' ] && { mv '${st.final}' '${st.staged}' 2>/dev/null; mv '${st.aside}' '${st.final}'; }`,
      ]),
      `  [ -e '${manifestAside}' ] && mv '${manifestAside}' '${paths.manifest}'`,
      `  rm '${markerFile}'   # only after the lines above`,
    ];
    throw new Error(`snapshot: install failed midway (${e instanceof Error ? e.message : String(e)}). Nothing was deleted. Undo it: for each part, put the new copy back into staging and move the old one back from ${aside}:\n${fix.join("\n")}\n(or re-run with --recover once the old parts are back)`);
  }
  rmSync(markerFile, { force: true });
  rmSync(stage, { recursive: true, force: true }); // our staging dir: its parts were all renamed out, only empty dirs remain
  if (!opts.workOnly && !existsSync(paths.kbBase) && source.kbBaseDir) throw new Error("snapshot: KB copy missing after install");

  const manifest: SnapshotManifest = {
    version: 1,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    source: prev ? { ...prev.source, workDir: source.workDir, ...(source.workBaseDir ? { workBaseDir: source.workBaseDir } : {}) } : source,
    counts: {
      ledgerEvents: trimTornLine(paths.ledgerFile),
      workItems: walkFiles(join(paths.workBase, "domains")).length,
      opsFiles: walkFiles(paths.kbOps).length,
      denFiles: walkFiles(prev ? join(devRoot, prev.den) : finalDen).length,
      kbBaseFiles: walkFiles(paths.kbBase).length,
    },
    den: prev ? prev.den : denRel,
    ledgerSha256: sha256File(paths.ledgerFile),
    includeSessions: prev ? prev.includeSessions : !!opts.includeSessions,
    excluded: prev ? prev.excluded : [...sessionExcludes, ...stateExcludes],
  };
  if (existsSync(paths.manifest)) moveAside(paths.manifest, aside); // never overwrite a manifest in place
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, paths };
}
