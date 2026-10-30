/**
 * hubd dev mode: a READ-ONLY snapshot of a wolfpack host's work ledger and KB, pulled over ssh/rsync into a fresh LOCAL data dir.
 *
 * SAFETY INVARIANT (owner's orders): there is NO code path in this module that pushes anything to a host. Every rsync invocation
 * is built by `buildPullArgs`, which accepts only a remote SOURCE (`user@addr:/abs/path`) and a local DESTINATION, and refuses
 * flags that mutate the source (`--delete*`, `--remove-source-files`, `--*-from`-style tricks). Writes made to the served hub
 * stay in the local copy and are never sent back. The transport (`PullRunner`) is injectable so tests never touch a network.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { hubRoots } from "./layout.js";

export const SNAPSHOT_MANIFEST = "snapshot-manifest.json";
export const DEV_MARKER = "DEV-SNAPSHOT";

/** Remote locations on a wolfpack host (see ops.md). `kb/base/domains` is a symlink there; the trailing slash makes rsync follow it. */
export const REMOTE_KB_DOMAINS = "/var/wolfpack/kb/base/domains/";
export const REMOTE_LEDGER = "/var/wolfpack/kb/work/ledger/work-events.jsonl";

export interface RemoteHost {
  name: string;
  address: string;
  user: string;
  port: number;
  identityFile: string;
}

export type PullRunner = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

/** Reads ONLY name/address/ssh user+port from the wolfpack config. Never touches (or returns) apiKey or other secrets. Parse errors are generic (a YAML code frame could echo secrets). */
export function resolveHost(name: string, configPath = join(homedir(), ".wolfpack", "config.yaml")): RemoteHost {
  let doc: { hosts?: Record<string, { address?: unknown; ssh?: { user?: unknown; port?: unknown } }> } | undefined;
  try {
    doc = parseYaml(readFileSync(configPath, "utf8")) as typeof doc;
  } catch {
    throw new Error(`cannot read or parse the wolfpack host config at ${configPath}`);
  }
  const h = doc?.hosts?.[name];
  if (!h || typeof h.address !== "string" || !h.address) throw new Error(`unknown host "${name}" in ${configPath} hosts:`);
  if (!/^[A-Za-z0-9.\-]+$/.test(h.address)) throw new Error(`host "${name}": suspicious address`);
  const user = typeof h.ssh?.user === "string" ? h.ssh.user : "root";
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error(`host "${name}": suspicious ssh user`);
  const rawPort = h.ssh?.port;
  const port = rawPort === undefined ? 22 : rawPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`cannot read or parse the wolfpack host config at ${configPath}`);
  return { name, address: h.address, user, port, identityFile: join(homedir(), ".ssh", "wolfpack") };
}

/** The `-e` value is split by rsync on whitespace with quote handling, so the identity path is double-quoted; quotes/backslashes in it are rejected. */
export function sshCommand(h: RemoteHost): string {
  if (/["'\\\n\r]/.test(h.identityFile)) throw new Error("ssh identity file path contains quotes, backslashes or newlines");
  return `ssh -i "${h.identityFile}" -p ${h.port} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`;
}

/**
 * The ONLY rsync argument builder. Strictly a pull: `<remote source> -> <local destination>`. No caller-supplied flags.
 * Throws when the destination is not a plain absolute local path or the source is not an absolute remote path.
 */
export function buildPullArgs(h: RemoteHost, remotePath: string, localDest: string): string[] {
  if (!remotePath.startsWith("/")) throw new Error("remote source must be an absolute path");
  if (/[\s;|&$`'"\\]/.test(remotePath)) throw new Error("remote source has unsafe characters");
  if (!localDest.startsWith("/") || /^[^/]*:/.test(localDest) || localDest.includes("@")) throw new Error("destination must be a plain absolute LOCAL path (never remote)");
  const source = `${h.user}@${h.address}:${remotePath}`;
  return ["-rt", "--timeout=60", "--no-owner", "--no-group", "--chmod=u+rwX", "-e", sshCommand(h), source, localDest];
}

const foldCase = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
const isWithin = (p: string, root: string) => foldCase(p) === foldCase(root) || foldCase(p).startsWith(foldCase(root) + sep);

/** Absolute path with symlinks of the deepest existing ancestor resolved (realpath.native), plus the not-yet-existing tail. */
function resolveReal(dir: string): { abs: string; real: string } {
  const abs = resolve(dir);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  return { abs, real: join(realpathSync.native(probe), ...tail) };
}

/**
 * Check 1, for BOTH `hubd serve` and `hubd dev`: a hub must never be pointed at a live Syncthing mirror or a den.
 * Refuses ~/wolves/knowledge/** and ANY `den` segment anywhere under ~/wolves. Symlinks are resolved; the resolved path is
 * what is checked AND returned. Case-insensitive on darwin. Deliberately does NOT refuse /var/wolfpack (a real VPS hub may live there).
 */
export function assertNotLiveMirror(dir: string, home = homedir()): string {
  const { abs, real } = resolveReal(dir);
  const wolvesRaw = join(home, "wolves");
  const wolvesRoots = new Set([wolvesRaw, existsSync(wolvesRaw) ? realpathSync.native(wolvesRaw) : wolvesRaw]);
  for (const p of new Set([abs, real])) {
    for (const wolves of wolvesRoots) {
      if (!isWithin(p, wolves)) continue;
      if (isWithin(p, join(wolves, "knowledge"))) throw new Error(`refusing data dir inside live knowledge: ${p}`);
      if (foldCase(p).slice(foldCase(wolves).length).split(sep).includes("den")) throw new Error(`refusing data dir inside a wolf den: ${p}`);
    }
  }
  return real;
}

/**
 * Check 2, `hubd dev` only: everything in assertNotLiveMirror, plus /var/wolfpack and /private/var/wolfpack (dev snapshots are
 * production-data copies and must never land in the live host tree). Returns the resolved path.
 */
export function assertSafeDevDataDir(dir: string, home = homedir()): string {
  const { abs, real } = resolveReal(dir);
  for (const p of new Set([abs, real]))
    for (const live of ["/var/wolfpack", "/private/var/wolfpack"]) if (isWithin(p, live)) throw new Error(`refusing data dir inside ${live}: ${p}`);
  return assertNotLiveMirror(dir, home);
}

export function defaultDevDataDir(now = new Date(), home = homedir()): string {
  return join(home, ".wolfpack", "hubd-dev", now.toISOString().replace(/[:.]/g, "-"));
}

export interface SnapshotManifest {
  sourceHost: string;
  sourceAddress: string;
  remotePaths: { ledger: string; kbDomains: string };
  /** false until BOTH pulls succeeded; an incomplete snapshot is never served and is the only kind a retry may reuse. */
  complete: boolean;
  takenAt: string;
  fileCount: number;
  ledgerSha256: string;
  ledgerBytes: number;
  readOnlySource: true;
}

export interface SnapshotOptions {
  host: string;
  dataDir: string;
  hostInfo?: RemoteHost;
  run?: PullRunner;
  now?: () => Date;
  home?: string;
}

export const defaultRunner: PullRunner = (cmd, args) =>
  new Promise((res) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("error", (e) => res({ code: 127, stderr: String(e) }));
    p.on("close", (code) => res({ code: code ?? 1, stderr }));
  });

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

export type SnapshotState = "none" | "incomplete" | "complete";

/** "none": no DEV-SNAPSHOT marker. "incomplete": marker but no manifest / unreadable / complete !== true. */
export function snapshotState(dataDir: string): SnapshotState {
  if (!existsSync(join(dataDir, DEV_MARKER))) return "none";
  try {
    const m = JSON.parse(readFileSync(join(dataDir, SNAPSHOT_MANIFEST), "utf8")) as { complete?: unknown };
    return m.complete === true ? "complete" : "incomplete";
  } catch {
    return "incomplete";
  }
}

/**
 * Pulls ledger + KB domains into `dataDir` (hub layout). The DEV-SNAPSHOT marker and a `complete: false` manifest are written
 * BEFORE pulling; the manifest flips to complete only after both pulls succeed. Refuses a non-empty dir that is not an
 * incomplete snapshot (a complete one holds local writes that a re-pull would overwrite: use a fresh dir).
 */
export async function takeSnapshot(opts: SnapshotOptions): Promise<SnapshotManifest> {
  const dataDir = assertSafeDevDataDir(opts.dataDir, opts.home);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    const state = snapshotState(dataDir);
    if (state === "none") throw new Error(`data dir ${dataDir} is non-empty and not a hubd dev snapshot`);
    if (state === "complete") throw new Error(`data dir ${dataDir} already holds a complete snapshot (possibly with local writes); use a fresh --data-dir, or omit --snapshot to re-serve it`);
  }
  const h = opts.hostInfo ?? resolveHost(opts.host);
  const run = opts.run ?? defaultRunner;
  const roots = hubRoots(dataDir);
  const ledgerDest = join(dataDir, "ledger", "work-events.jsonl");
  const kbDest = join(roots.kbBase, "domains") + "/";
  mkdirSync(join(dataDir, "ledger"), { recursive: true });
  mkdirSync(kbDest, { recursive: true });
  const manifest: SnapshotManifest = {
    sourceHost: h.name,
    sourceAddress: h.address,
    remotePaths: { ledger: REMOTE_LEDGER, kbDomains: REMOTE_KB_DOMAINS },
    complete: false,
    takenAt: (opts.now?.() ?? new Date()).toISOString(),
    fileCount: 0,
    ledgerSha256: "",
    ledgerBytes: 0,
    readOnlySource: true,
  };
  const writeManifest = () => writeFileSync(join(dataDir, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  writeManifest();
  writeFileSync(join(dataDir, DEV_MARKER), `Local-only copy of ${h.name} taken ${manifest.takenAt}. Writes stay here and are never pushed back.\nContains production data: delete when done.\n`);
  for (const [src, dest] of [
    [REMOTE_LEDGER, ledgerDest],
    [REMOTE_KB_DOMAINS, kbDest],
  ] as const) {
    const r = await run("rsync", buildPullArgs(h, src, dest));
    if (r.code !== 0) throw new Error(`rsync pull of ${src} from ${h.name} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  }
  manifest.fileCount = 1 + countFiles(kbDest);
  manifest.ledgerSha256 = createHash("sha256").update(readFileSync(ledgerDest)).digest("hex");
  manifest.ledgerBytes = statSync(ledgerDest).size;
  manifest.complete = true;
  writeManifest();
  return manifest;
}

export function isDevSnapshot(dataDir: string): boolean {
  return existsSync(join(dataDir, DEV_MARKER));
}
