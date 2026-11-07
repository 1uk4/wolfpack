/**
 * wolfpack pr prepare [--full] [--dry-run] [--base stable]
 * Opens (or updates) the release PR from the current wolf/<wolf> branch into stable. The owner merges it.
 * wolfpack pr post-merge [--dry-run] [--apply]
 * Bookkeeping after the owner merged: fetch, fast-forward, archive and clean up feature branches, rebuild.
 * This file only wires the real git, gh, build and work-API access into prPrepare (pr-prepare.ts) and prPostMerge (pr-post-merge.ts).
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCommands, detectPm } from "../pm.js";
import { prPostMerge, type PostMergeOptions } from "../pr-post-merge.js";
import { verifyChanges, type Affected } from "../pr-verify.js";
import { prPrepare, PrRefusal, type CmdResult, type PrDeps, type PrPrepareOptions } from "../pr-prepare.js";

export interface PrCmdOptions extends PrPrepareOptions {
  cwd?: string;
}

/** Build and test steps may take a while on a full suite. */
const STEP_TIMEOUT_MS = 20 * 60_000;

function sh(cmd: string, args: string[], cwd: string, input?: string, timeout?: number): CmdResult {
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 1 << 26, timeout });
  const err = r.error ? `${r.stderr ?? ""}${r.error.message}` : (r.stderr ?? "");
  return { code: r.status ?? 1, out: r.stdout ?? "", err };
}

function realDeps(root: string): PrDeps {
  const endpoint = (process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
  const token = process.env.WORK_TOKEN ?? "";
  return {
    git: (args) => sh("git", args, root),
    gh: (args, input) => sh("gh", args, root, input),
    workConfigured: () => Boolean(endpoint && token),
    async work(id) {
      if (!endpoint || !token) throw new PrRefusal("Work API not configured (set WORK_ENDPOINT and WORK_TOKEN)");
      // A network failure or a bad status throws a plain Error: prepare warns and files that commit under Other commits.
      const res = await fetch(`${endpoint}/work/${encodeURIComponent(id)}`, { headers: { "x-api-key": token }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /work/${id} returned ${res.status}`);
      return (await res.json()) as { item: { id: string; kind: string; title: string; partOf?: string | null }; body: string | null };
    },
    async verify({ base, full }) {
      // Same steps as CI: tsc --build and vitest over the affected packages, console tests if affected.
      const aff = (await import(pathToFileURL(path.join(root, "scripts/affected.mjs")).href)) as {
        computeAffected(c: string[] | null, ws: unknown): Affected;
        changedFiles(b: string | null, h: string, cwd: string): string[] | null;
        loadWorkspaces(r: string): unknown;
      };
      const a = aff.computeAffected(full ? null : aff.changedFiles(base, "HEAD", root), aff.loadWorkspaces(root));
      return verifyChanges(a, detectPm(root), (cmd, args) => sh(cmd, args, root, undefined, STEP_TIMEOUT_MS));
    },
    now: () => new Date(),
    log: (l) => console.log(l),
  };
}

export async function prCmd(opts: PrCmdOptions): Promise<void> {
  const root = sh("git", ["rev-parse", "--show-toplevel"], opts.cwd ?? process.cwd()).out.trim();
  try {
    await prPrepare(opts, realDeps(root));
  } catch (err) {
    if (err instanceof PrRefusal) {
      console.error(`refused: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export async function postMergeCmd(opts: PostMergeOptions & { cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const r = await prPostMerge(opts, {
      git: (args, at) => sh("git", args, at ?? cwd),
      // The same command as scripts/runtime-update.mjs. The root "build" script is plain tsc; turbo is what the runtime uses (a pnpm checkout installs first; an npm one is unchanged).
      build: (at) => {
        let last: CmdResult = { code: 0, out: "", err: "" };
        for (const c of buildCommands(detectPm(at))) {
          last = sh(c.cmd, c.args, at, undefined, STEP_TIMEOUT_MS);
          if (last.code !== 0) break;
        }
        return last;
      },
      realpath: (p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      },
      log: (l) => console.log(l),
    });
    if (r.failed) process.exit(1);
  } catch (err) {
    if (err instanceof PrRefusal) {
      console.error(`refused: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
