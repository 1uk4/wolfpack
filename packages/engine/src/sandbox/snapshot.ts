/**
 * Snapshot: copy a wolfpack host's work ledger, contributions lanes and one wolf's den into a dev root
 * (layout.ts). READ-ONLY on the source; every write lands under `devRoot`.
 *
 * Each source part is either a local path or a remote spec `[user@]host:/abs/path` (fetched with rsync over ssh).
 * Tests and local dev use local paths; the remote variant exists for sfo-01 and is never exercised in CI.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realPathLoose } from "./resolve.js";
import { sandboxPaths, SNAPSHOT_MANIFEST, type SandboxPaths } from "./layout.js";

export interface SnapshotSource {
  /** Dir holding `ledger/work-events.jsonl` (sfo-01: /var/wolfpack/kb/work). */
  workDir: string;
  /** Dir holding `domains/<d>/work/*.md` (sfo-01: /var/wolfpack/kb/base). Optional: the ledger alone is enough. */
  workBaseDir?: string;
  /** KB ops root with `inbox|receipts|parked/<wolf>` (sfo-01: /var/wolfpack/kb/ops). */
  opsDir: string;
  /** The wolf's den (sfo-01: /home/wolf-<id>/den). */
  denDir: string;
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
  now?: () => Date;
}

export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  source: SnapshotSource;
  counts: { ledgerEvents: number; workItems: number; opsFiles: number; denFiles: number };
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

/** ssh transport for rsync -e. The identity is one argv element, quoted for rsync's own re-splitting. */
export function sshCommand(identity?: string): string {
  const base = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  // Same hygiene as the wolfpack CLI: only the given key, never a desktop ssh-agent.
  if (identity) base.push("-i", `'${identity.replace(/'/g, `'\\''`)}'`, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none");
  return base.join(" ");
}

/** Pure: the exact rsync argv for one remote part. `--` guards against a spec starting with `-`. */
export function rsyncArgv(spec: string, dest: string, rules: string[], identity?: string, opts: { local?: boolean } = {}): string[] {
  return ["-a", "--no-links", ...(opts.local ? [] : ["-e", sshCommand(identity)]), ...rules, "--", spec.replace(/\/?$/, "/"), `${dest}/`];
}

/** Filter rules per part; `ledger` copies <src>/ledger/work-events.jsonl into <dest>/ledger/. */
export const RSYNC_RULES = {
  ledger: ["--include=/ledger/", "--include=/ledger/work-events.jsonl", "--exclude=*"],
  workMd: ["--include=/domains/", "--include=/domains/*/", "--include=/domains/*/work/", "--include=/domains/*/work/*.md", "--exclude=*"],
  /** Anchored to the den root, so a same-named path deeper in the tree is untouched. */
  denState: DEN_STATE_EXCLUDES.map((e) => `--exclude=/${e}`),
  ops: ["--include=/inbox/", "--include=/inbox/**", "--include=/receipts/", "--include=/receipts/**", "--include=/parked/", "--include=/parked/**", "--exclude=*"],
} as const;

/** @internal `local` runs rsync's local mode (no ssh) so tests can prove the filters on a plain directory. */
export function copyRemote(spec: string, dest: string, rules: string[], identity?: string, opts: { local?: boolean } = {}): void {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("rsync", rsyncArgv(spec, dest, rules, identity, opts), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`rsync from ${spec} failed (${r.status ?? r.error?.message}): ${(r.stderr ?? "").trim().split("\n")[0]}`);
}

function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse a dev root that overlaps any local source (snapshotting into the live tree would be the whole bug). */
function assertDisjoint(devRoot: string, source: SnapshotSource): void {
  const root = realPathLoose(devRoot);
  for (const [label, spec] of Object.entries(source)) {
    if (typeof spec !== "string" || isRemoteSpec(spec)) continue;
    const s = realPathLoose(spec);
    if (insideOrEqual(s, root) || insideOrEqual(root, s)) {
      throw new Error(`snapshot: dev root ${devRoot} overlaps source ${label} ${spec}`);
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

export function takeSnapshot(opts: SnapshotOptions): SnapshotManifest & { paths: SandboxPaths } {
  const { source } = opts;
  const devRoot = resolve(opts.devRoot);
  const paths = sandboxPaths(devRoot);
  assertDisjoint(devRoot, source);

  if (existsSync(devRoot) && readdirSync(devRoot).length > 0) {
    if (!existsSync(paths.manifest)) throw new Error(`snapshot: ${devRoot} exists, is not empty and is not a snapshot; refusing`);
    if (!opts.force) throw new Error(`snapshot: ${devRoot} already holds a snapshot (use force to replace)`);
    for (const part of ["ledger", "base", "ops", "den", SNAPSHOT_MANIFEST]) {
      // Only the dirs a snapshot creates; anything else under the root is left alone.
      const p = join(devRoot, part);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  }
  mkdirSync(devRoot, { recursive: true });

  const sessionExcludes = opts.includeSessions ? [] : SESSION_EXCLUDES;
  const stateExcludes = opts.includeSessions ? [] : DEN_STATE_EXCLUDES;
  const ledgerRel = (rel: string, _isDir?: boolean) => rel === "ledger" || rel === join("ledger", "work-events.jsonl");
  const isWorkMd = (rel: string, isDir: boolean) => {
    const parts = rel.split(sep);
    if (isDir) return parts.length < 3 || (parts[0] === "domains" && (parts.length === 2 || parts[2] === "work"));
    return parts[0] === "domains" && parts[2] === "work" && rel.endsWith(".md");
  };
  const opsLane = (rel: string) => ["inbox", "receipts", "parked"].includes(rel.split(sep)[0]);

  if (isRemoteSpec(source.workDir)) {
    copyRemote(source.workDir, devRoot, [...RSYNC_RULES.ledger], opts.sshIdentity);
  } else {
    copyLocal(source.workDir, devRoot, ledgerRel);
  }
  if (source.workBaseDir) {
    if (isRemoteSpec(source.workBaseDir)) {
      copyRemote(source.workBaseDir, paths.workBase, [...RSYNC_RULES.workMd], opts.sshIdentity);
    } else {
      copyLocal(source.workBaseDir, paths.workBase, isWorkMd);
    }
  }
  if (isRemoteSpec(source.opsDir)) {
    copyRemote(source.opsDir, paths.kbOps, [...RSYNC_RULES.ops], opts.sshIdentity);
  } else {
    copyLocal(source.opsDir, paths.kbOps, opsLane);
  }
  if (isRemoteSpec(source.denDir)) {
    copyRemote(source.denDir, paths.den, [...stateExcludes.map((e) => `--exclude=/${e}`), ...sessionExcludes.map((e) => `--exclude=${e}`)], opts.sshIdentity);
  } else {
    copyLocal(source.denDir, paths.den, (rel) => !denExcluded(rel, sessionExcludes, stateExcludes));
  }
  // A torn line is never valid JSON; an empty ledger must still exist so the work server starts clean.
  mkdirSync(join(devRoot, "ledger"), { recursive: true });
  if (!existsSync(paths.ledgerFile)) writeFileSync(paths.ledgerFile, "");
  if (isRemoteSpec(source.workDir) && trimTornLine(paths.ledgerFile) === 0) {
    throw new Error(`snapshot: remote ledger ${source.workDir} yielded 0 events (wrong path or filter?); refusing a silent empty snapshot`);
  }
  mkdirSync(paths.kbOps, { recursive: true });
  mkdirSync(paths.den, { recursive: true });

  const manifest: SnapshotManifest = {
    version: 1,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    source,
    counts: {
      ledgerEvents: trimTornLine(paths.ledgerFile),
      workItems: walkFiles(join(paths.workBase, "domains")).length,
      opsFiles: walkFiles(paths.kbOps).length,
      denFiles: walkFiles(paths.den).length,
    },
    includeSessions: !!opts.includeSessions,
    excluded: [...sessionExcludes, ...stateExcludes],
  };
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, paths };
}
