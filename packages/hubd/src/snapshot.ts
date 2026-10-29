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

/** Reads ONLY name/address/ssh user+port from the wolfpack config. Never touches (or returns) apiKey or other secrets. */
export function resolveHost(name: string, configPath = join(homedir(), ".wolfpack", "config.yaml")): RemoteHost {
  const doc = parseYaml(readFileSync(configPath, "utf8")) as { hosts?: Record<string, { address?: unknown; ssh?: { user?: unknown; port?: unknown } }> };
  const h = doc?.hosts?.[name];
  if (!h || typeof h.address !== "string" || !h.address) throw new Error(`unknown host "${name}" in ${configPath} hosts:`);
  if (!/^[A-Za-z0-9.\-]+$/.test(h.address)) throw new Error(`host "${name}": suspicious address`);
  const user = typeof h.ssh?.user === "string" ? h.ssh.user : "root";
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error(`host "${name}": suspicious ssh user`);
  const port = typeof h.ssh?.port === "number" ? h.ssh.port : 22;
  return { name, address: h.address, user, port, identityFile: join(homedir(), ".ssh", "wolfpack") };
}

export function sshCommand(h: RemoteHost): string {
  return `ssh -i ${h.identityFile} -p ${h.port} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o ConnectTimeout=5`;
}

const FORBIDDEN_FLAG = /^--(delete|remove|move|files-from|exclude-from|include-from)/;

/**
 * The ONLY rsync argument builder. Strictly a pull: `<remote source> -> <local destination>`.
 * Throws when the destination is not a plain absolute local path, the source is not `user@addr:/abs`, or a mutating flag is present.
 */
export function buildPullArgs(h: RemoteHost, remotePath: string, localDest: string, extraFlags: string[] = []): string[] {
  if (!remotePath.startsWith("/")) throw new Error("remote source must be an absolute path");
  if (/[\s;|&$`'"\\]/.test(remotePath)) throw new Error("remote source has unsafe characters");
  if (!localDest.startsWith("/") || /^[^/]*:/.test(localDest) || localDest.includes("@")) throw new Error("destination must be a plain absolute LOCAL path (never remote)");
  for (const f of extraFlags) if (FORBIDDEN_FLAG.test(f)) throw new Error(`forbidden rsync flag ${f}`);
  const source = `${h.user}@${h.address}:${remotePath}`;
  return ["-rt", "--no-owner", "--no-group", "--chmod=u+rwX", ...extraFlags, "-e", sshCommand(h), source, localDest];
}

/** Refuses data dirs inside live knowledge/den trees (~/wolves/knowledge, ~/wolves/*\/den, /var/wolfpack). Resolves symlinks of the deepest existing ancestor. */
export function assertSafeDataDir(dir: string, home = homedir()): string {
  const abs = resolve(dir);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  const real = join(realpathSync(probe), ...tail);
  const wolvesRaw = join(home, "wolves");
  const wolvesList = new Set([wolvesRaw, existsSync(wolvesRaw) ? realpathSync(wolvesRaw) : wolvesRaw]);
  const within = (p: string, root: string) => p === root || p.startsWith(root + sep);
  const candidates = new Set([abs, real]);
  for (const p of candidates) {
    if (within(p, "/var/wolfpack")) throw new Error(`refusing data dir inside /var/wolfpack: ${p}`);
    for (const wolves of wolvesList) {
      if (within(p, join(wolves, "knowledge"))) throw new Error(`refusing data dir inside live knowledge: ${p}`);
      if (within(p, wolves)) {
        const rel = p.slice(wolves.length + 1).split(sep);
        // ~/wolves/<host>/<wolf>/den[/...]  (host dirs: local, sfo-01, ...)
        if (rel[2] === "den" || rel[1] === "den") throw new Error(`refusing data dir inside a wolf den: ${p}`);
      }
    }
  }
  return abs;
}

export function defaultDevDataDir(now = new Date(), home = homedir()): string {
  return join(home, ".wolfpack", "hubd-dev", now.toISOString().replace(/[:.]/g, "-"));
}

export interface SnapshotManifest {
  sourceHost: string;
  sourceAddress: string;
  remotePaths: { ledger: string; kbDomains: string };
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

/** Pulls ledger + KB domains into `dataDir` (hub layout), writes the manifest and the DEV-SNAPSHOT marker. */
export async function takeSnapshot(opts: SnapshotOptions): Promise<SnapshotManifest> {
  const dataDir = assertSafeDataDir(opts.dataDir, opts.home);
  const marker = join(dataDir, DEV_MARKER);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0 && !existsSync(marker)) throw new Error(`data dir ${dataDir} is non-empty and not a hubd dev snapshot`);
  const h = opts.hostInfo ?? resolveHost(opts.host);
  const run = opts.run ?? defaultRunner;
  const roots = hubRoots(dataDir);
  const ledgerDest = join(dataDir, "ledger", "work-events.jsonl");
  const kbDest = join(roots.kbBase, "domains") + "/";
  mkdirSync(join(dataDir, "ledger"), { recursive: true });
  mkdirSync(kbDest, { recursive: true });
  for (const [src, dest] of [
    [REMOTE_LEDGER, ledgerDest],
    [REMOTE_KB_DOMAINS, kbDest],
  ] as const) {
    const r = await run("rsync", buildPullArgs(h, src, dest));
    if (r.code !== 0) throw new Error(`rsync pull of ${src} from ${h.name} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
  }
  const ledger = readFileSync(ledgerDest);
  const manifest: SnapshotManifest = {
    sourceHost: h.name,
    sourceAddress: h.address,
    remotePaths: { ledger: REMOTE_LEDGER, kbDomains: REMOTE_KB_DOMAINS },
    takenAt: (opts.now?.() ?? new Date()).toISOString(),
    fileCount: 1 + countFiles(kbDest),
    ledgerSha256: createHash("sha256").update(ledger).digest("hex"),
    ledgerBytes: statSync(ledgerDest).size,
    readOnlySource: true,
  };
  writeFileSync(join(dataDir, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(marker, `Local-only copy of ${h.name} taken ${manifest.takenAt}. Writes stay here and are never pushed back.\nContains production data: delete when done.\n`);
  return manifest;
}

export function isDevSnapshot(dataDir: string): boolean {
  return existsSync(join(dataDir, DEV_MARKER));
}
