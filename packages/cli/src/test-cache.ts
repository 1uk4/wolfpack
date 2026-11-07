/**
 * The host-local result cache for `wolfpack test`. A PASS is reused only when the same files, command and environment
 * already passed on this host. Failures are never stored, and neither is any run that included a test that reads the
 * developer's home config (its result depends on state outside the repo; a full run therefore never caches).
 * Store: `~/.cache/wolfpack/test-results/<key>.json`, evicted after 14 days or past 200 entries.
 *
 * Passes are shared across worktrees (and between the owner and agents) BY CONTENT, on purpose: the key holds file
 * contents, never paths or the checkout's name, so a second worktree at the same content reuses the first one's pass.
 * Who runs it (WOLFPACK_AGENT_RUN, WOLFPACK_TEST_BYPASS, PI_SUBAGENT_*) is not in the key for the same reason.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "wolfpack", "test-results");
export const MAX_AGE_MS = 14 * 86_400_000;
export const MAX_ENTRIES = 200;
/** Only these environment variables are part of the key. */
export const ENV_ALLOW_LIST = ["CI", "TZ", "LANG", "LC_ALL", "NODE_OPTIONS", "FORCE_COLOR"] as const;

/**
 * Tests whose outcome depends on the real home directory or its config.
 * Method: the whole default suite was run once with HOME pointed at an empty temp dir. Of 4421 tests, the files below
 * marked "measured" failed (they need the pack config's models: block) and pass again under the real HOME.
 * The others pass either way but read or write under the real home by absolute path (their expected values come from
 * the same homedir()), so they are kept out of the cache as a precaution; a wrongly uncached run only costs a rerun.
 */
export const HOME_CONFIG_TESTS = [
  // measured
  "extensions/wolfpack-memory/consolidation-trigger.integration.test.ts",
  "extensions/wolfpack-memory/session-topics.integration.test.ts",
  "extensions/wolfpack-memory/unbind-on-complete.test.ts",
  // read by hand: real homedir() / HOME
  "packages/harness/src/wolfd/subagents-containment.test.ts",
  "packages/cli/src/sandbox-cmd.test.ts",
  "packages/hubd/src/devmode.test.ts",
  "packages/kb/src/shared/mirror-guard.test.ts",
  "apps/console/tests/read-tool.test.ts",
];

const sha = (...parts: string[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(`${p.length}:${p}`);
  return h.digest("hex");
};

const gitOut = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });

const fileHash = (root: string, rel: string) => {
  try {
    return createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  } catch {
    return "gone";
  }
};

/**
 * Hash of every file under `dir` (path order) except type declarations and source maps; node_modules is skipped.
 * Symlinks are followed (statSync) and the target's content is hashed; `seen` holds the real paths of the directories
 * already entered, so a link back up the tree cannot loop.
 */
function treeHash(h: ReturnType<typeof createHash>, dir: string, rel: string, seen = new Set<string>()): void {
  let names: string[];
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    let st: import("node:fs").Stats;
    try {
      st = statSync(full);
    } catch {
      continue; // a dangling link
    }
    if (st.isDirectory()) treeHash(h, full, `${rel}/${name}`, seen);
    else if (st.isFile() && !/\.d\.ts$|\.map$/.test(name)) h.update(`${rel}/${name}\0`).update(readFileSync(full)).update("\0");
  }
}

/**
 * Hash of the built output the tests import: vitest has no alias for @wolfpack/*, so `import "@wolfpack/engine"`
 * resolves through node_modules to packages/<pkg>/dist (gitignored, so git's view does not cover it).
 */
function distHash(root: string): string {
  const h = createHash("sha256");
  let pkgs: string[] = [];
  try {
    pkgs = readdirSync(join(root, "packages")).sort();
  } catch {
    /* no packages dir */
  }
  for (const p of pkgs) treeHash(h, join(root, "packages", p, "dist"), `packages/${p}/dist`);
  return h.digest("hex");
}

/**
 * pi-claude-bridge-stateless is a Mac-only git/file dependency: the lockfile names it by commit, but what is installed
 * may be a local checkout or a link that moved on. Its installed version, the `resolved` the install recorded, and
 * the content of its package.json and built/source files are part of the key.
 */
function bridgeStamp(root: string): string {
  const dir = join(root, "node_modules", "pi-claude-bridge-stateless");
  if (!existsSync(dir)) return "bridge:absent";
  const h = createHash("sha256");
  h.update(fileHash(root, "node_modules/pi-claude-bridge-stateless/package.json"));
  try {
    const installed = JSON.parse(readFileSync(join(root, "node_modules", ".package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string; resolved?: string }> };
    const e = installed.packages?.["node_modules/pi-claude-bridge-stateless"];
    h.update(`${e?.version ?? ""} ${e?.resolved ?? ""}`);
  } catch {
    /* no install record */
  }
  for (const sub of ["dist", "src"]) treeHash(h, join(dir, sub), sub);
  return `bridge:${h.digest("hex")}`;
}

/**
 * Config files under the home config dir (~/.wolfpack) that the code reads: config.yaml (CLI config and the pack
 * models: block), domains.yaml (the domain registry), devices.yaml (the mesh), .env (global secrets; only hashed, never
 * stored). Run state, logs, keys and the usage and workerd dirs are not config and are left out.
 * Blind spot, on purpose: a test that reads any OTHER file under the home directory is not covered by this hash;
 * such tests are listed in HOME_CONFIG_TESTS, which are never cached.
 */
export const HOME_CONFIG_FILES = ["config.yaml", "domains.yaml", "devices.yaml", ".env"] as const;

function configHash(configDir: string): string {
  const h = createHash("sha256");
  for (const f of HOME_CONFIG_FILES) {
    try {
      h.update(`${f}\0`).update(readFileSync(join(configDir, f))).update("\0");
    } catch {
      h.update(`${f}:absent\0`);
    }
  }
  return h.digest("hex");
}

/** `related` takes a set of files: their order must not matter. */
function normaliseArgs(args: string[]): string[] {
  if (args[0] !== "related") return args;
  const flags = args.slice(1).filter((a) => a.startsWith("-"));
  const files = args.slice(1).filter((a) => !a.startsWith("-")).sort();
  return ["related", ...flags, ...files];
}

export interface KeyInput {
  root: string;
  args: string[];
  vitestVersion: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** The home config dir (default ~/.wolfpack); injectable for tests. */
  configDir?: string;
}

export function cacheKey(i: KeyInput): string {
  const { root } = i;
  const env = i.env ?? process.env;
  const dirty = gitOut(root, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const untracked = gitOut(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  const changed = [...new Set([...dirty, ...untracked])].sort().map((f) => `${f}=${fileHash(root, f)}`);
  const lock = ["package-lock.json", "pnpm-lock.yaml"].find((f) => existsSync(join(root, f)));
  return sha(
    gitOut(root, ["ls-files", "-s"]),
    changed.join("\n"),
    JSON.stringify(normaliseArgs(i.args)),
    i.nodeVersion ?? process.version,
    i.vitestVersion,
    lock ? `${lock}=${fileHash(root, lock)}` : "no-lockfile",
    distHash(root),
    bridgeStamp(root),
    configHash(i.configDir ?? join(homedir(), ".wolfpack")),
    `${process.platform}-${process.arch}`,
    ENV_ALLOW_LIST.map((k) => `${k}=${env[k] ?? ""}`).join("\n"),
  );
}

export interface CacheRun {
  status: "pass" | "fail";
  /** The test files that actually ran. */
  files: string[];
  args: string[];
}

export function openCache(o: { dir?: string; now?: () => number; maxEntries?: number; maxAgeMs?: number } = {}) {
  const dir = o.dir ?? DEFAULT_CACHE_DIR;
  const now = o.now ?? Date.now;
  const maxEntries = o.maxEntries ?? MAX_ENTRIES;
  const maxAge = o.maxAgeMs ?? MAX_AGE_MS;

  const entries = () => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      try {
        const e = JSON.parse(readFileSync(join(dir, n), "utf8")) as { at: number };
        return typeof e.at === "number" ? [{ n, at: e.at }] : [];
      } catch {
        return [];
      }
    });
  };

  const evict = () => {
    const all = entries().sort((a, b) => b.at - a.at);
    all.forEach((e, i) => {
      if (now() - e.at > maxAge || i >= maxEntries) rmSync(join(dir, e.n), { force: true });
    });
  };

  return {
    /** When the same state last passed, or undefined. */
    lookup(key: string): { at: number } | undefined {
      try {
        const e = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as { at: number };
        if (typeof e.at !== "number" || now() - e.at > maxAge) return undefined;
        return { at: e.at };
      } catch {
        return undefined;
      }
    },

    /** Store a pass. False (nothing written) for a failure or a run that included a home-config test. */
    store(key: string, run: CacheRun): boolean {
      if (run.status !== "pass") return false;
      if (run.files.some((f) => HOME_CONFIG_TESTS.some((h) => f === h || f.endsWith(`/${h}`)))) return false;
      mkdirSync(dir, { recursive: true });
      // temp file + rename: a reader never sees a half-written entry
      const tmp = join(dir, `.${key}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ at: now(), args: run.args, files: run.files }));
      renameSync(tmp, join(dir, `${key}.json`));
      evict();
      return true;
    },
  };
}
