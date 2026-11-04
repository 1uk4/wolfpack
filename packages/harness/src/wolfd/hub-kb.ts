/**
 * Hub-backed KB for a wolf that has no Syncthing and no readable workerd mirror (a VPS wolf under workerd-wolves: wolfd runs as
 * wolf-<name>, sees only its own home, and workerd cannot read that home).
 *
 * Opt-in: env WOLFPACK_HUB_KB=1 plus WOLFPACK_HUB_URL and WOLFPACK_HUB_TOKEN (a hubd WORKER token of the wolf's host, from the wolf's 600 `.env`).
 * Anything else = nothing here runs and the wolf behaves exactly as before (Syncthing wolves unchanged).
 *
 *  READ   a KbSync (the same class workerd uses) mirrors the wolf's domains (wolf.yaml `domains`, which the hub registry must also list) from
 *         the hub into `<home>/kb-mirror` (layout "base": `domains/<d>/…`), and KB_BASE points there (unless set).
 *  WRITE  memory's emitDelta keeps writing `<KB_OPS>/inbox/<wolf>/*.md` (KB_OPS defaults to `<home>/ops`); a feeder scans that lane and
 *         POSTs each file to hubd `/v1/contributions`; only a 2xx moves the file to `<lane>/sent/`. Failures (see `classify`):
 *         a terminal 4xx (or an unparseable file) moves the file to `<lane>/rejected/` (+ `.reason.json`) and is never retried;
 *         401/403/404/405/410 mean a config problem (token, URL, grant): the file stays and backs off on its own; a 401 (token-wide), or
 *         two distinct files failing that way in one pass, stops the pass and backs the whole feeder off with one ERROR line (a single
 *         403/404/410 can be specific to one contribution, so it must not block the files behind it); transient failures (network, 5xx, 408, 429) back off per file (5 s .. 5 min).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KbSync } from "@wolfpack/kb/sync";
import { parseContribution } from "@wolfpack/kb/librarian/intake";
import { HubHttpError, postContribution } from "@wolfpack/memory";
import type { WolfConfig } from "@wolfpack/engine";

export interface HubKbEnv {
  hubUrl: string;
  token: string;
  mirrorDir: string;
  kbOps: string;
}

/** The hub KB settings in `env`, or undefined when not enabled. */
export function hubKbFromEnv(config: WolfConfig, env: NodeJS.ProcessEnv): HubKbEnv | undefined {
  if (!/^(1|true|yes|on)$/i.test((env.WOLFPACK_HUB_KB ?? "").trim())) return undefined;
  const hubUrl = env.WOLFPACK_HUB_URL?.trim();
  const token = env.WOLFPACK_HUB_TOKEN?.trim();
  if (!hubUrl || !token) throw new Error("WOLFPACK_HUB_KB=1 needs WOLFPACK_HUB_URL and WOLFPACK_HUB_TOKEN (in the wolf's .env)");
  const home = env.WOLF_HOME?.trim() || dirname(config.file);
  return { hubUrl, token, mirrorDir: env.KB_BASE?.trim() || join(home, "kb-mirror"), kbOps: env.KB_OPS?.trim() || join(home, "ops") };
}

export interface FeedPass {
  sent: number;
  failed: number;
  /** Moved to `rejected/` (terminal 4xx or unparseable). */
  rejected: number;
  /** Skipped this pass because of backoff. */
  deferred: number;
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
const REASON_MAX = 64;
const MSG_MAX = 200;

/** Retry state kept by the caller across passes: per-file backoff, plus one shared backoff for config failures. */
export interface FeedState {
  files: Map<string, { fails: number; nextAt: number; /** When the file was last attempted (ordering: least recently attempted first). */ last: number }>;
  auth: { fails: number; nextAt: number };
}
export const newFeedState = (): FeedState => ({ files: new Map(), auth: { fails: 0, nextAt: 0 } });

export type Failure = "terminal" | "config" | "retry";

const backoff = (fails: number): number => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (fails - 1));

/**
 * What to do with a failed post. 401/403/404/405/410 = config problem (bad token, wrong URL, wolf not granted): keep the file, back off
 * (the caller decides whether it is file-specific or global).
 * Other 4xx except 408/429 = the hub will never accept this file. Everything else, including a plain Error from a transport failure
 * (postContribution throws a plain Error when the hub cannot be reached), is transient.
 */
export function classify(e: unknown): Failure {
  if (!(e instanceof HubHttpError)) return "retry";
  const s = e.status;
  if (s === 401 || s === 403 || s === 404 || s === 405 || s === 410) return "config";
  if (s >= 400 && s < 500 && s !== 408 && s !== 429) return "terminal";
  return "retry";
}

/** Error text safe to log and persist: no bearer token value, no URL userinfo, capped. */
function safeMsg(e: unknown, token: string, max = MSG_MAX): string {
  let m = e instanceof Error ? e.message : String(e);
  if (token) m = m.split(token).join("[token]");
  return m.replace(/(\/\/)[^/@\s]*@/g, "$1").slice(0, max);
}

/** One pass over `<kbOps>/inbox/<wolf>`: POST each contribution file to the hub; move the accepted ones to `sent/`. Never throws. */
export async function feedInboxToHub(
  kbOps: string,
  wolf: string,
  hub: { baseUrl: string; token: string; fetch?: typeof fetch },
  log: (l: string) => void,
  opts: { state?: FeedState; now?: () => number } = {}
): Promise<FeedPass> {
  const res: FeedPass = { sent: 0, failed: 0, rejected: 0, deferred: 0 };
  const state = opts.state ?? newFeedState();
  const now = opts.now ?? Date.now;
  const lane = join(kbOps, "inbox", wolf);
  let names: string[];
  try {
    names = readdirSync(lane).sort();
  } catch {
    return res;
  }
  // Drop backoff entries of files that are no longer in the inbox (sent, rejected, deleted by hand).
  const present = new Set(names);
  for (const k of [...state.files.keys()]) if (!present.has(k)) state.files.delete(k);

  // A crash between writing and renaming a reason file leaves a tmp file behind; remove it.
  try {
    for (const n of readdirSync(join(lane, "rejected"))) if (/\.reason\.json\.tmp-/.test(n)) rmSync(join(lane, "rejected", n), { force: true });
  } catch {}

  // Least recently attempted first: never-attempted files, then by last attempt, ties by name. Files a tripped breaker left behind were
  // not attempted, so they come ahead of the poisoned ones that tripped it; a few poisoned files at the front cannot starve the rest.
  const eligible = names
    .filter((n) => !n.startsWith(".") && n.endsWith(".md") && !/\.tmp-/.test(n))
    .sort((a, b) => (state.files.get(a)?.last ?? -Infinity) - (state.files.get(b)?.last ?? -Infinity) || (a < b ? -1 : a > b ? 1 : 0));
  if (state.auth.nextAt > now()) {
    res.deferred = eligible.length;
    return res;
  }
  /** Move `name` into `<lane>/<dir>/`, avoiding a name clash (and a clash of the matching reason file). Returns the final name. */
  const move = (name: string, dir: string, reason?: object): string => {
    const dest = join(lane, dir);
    mkdirSync(dest, { recursive: true });
    let n = 0;
    let cand = name;
    while (existsSync(join(dest, cand)) || existsSync(join(dest, `${cand}.reason.json`))) cand = `${name}.${++n}`;
    if (reason) {
      const rp = join(dest, `${cand}.reason.json`);
      const tmp = `${rp}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, JSON.stringify(reason, null, 2) + "\n");
        renameSync(tmp, rp);
      } catch (e) {
        log(`hub-kb: could not write the reason file for ${name}: ${safeMsg(e, hub.token)}`);
      }
    }
    renameSync(join(lane, name), join(dest, cand));
    return cand;
  };
  const reject = (name: string, status: number | undefined, message: string, reason: string | undefined): boolean => {
    try {
      move(name, "rejected", { ...(status !== undefined ? { status } : {}), message, ...(reason ? { reason } : {}), at: new Date(now()).toISOString() });
      state.files.delete(name);
      res.rejected++;
      return true;
    } catch (e) {
      log(`hub-kb: could not move ${name} to rejected/ (${safeMsg(e, hub.token)}); keeping it and retrying with backoff`);
      return false;
    }
  };
  const retryLater = (name: string): number => {
    const fails = (state.files.get(name)?.fails ?? 0) + 1;
    const wait = backoff(fails);
    state.files.set(name, { fails, nextAt: now() + wait, last: now() });
    res.failed++;
    return wait;
  };

  const configFailed = new Set<string>();
  for (let i = 0; i < eligible.length; i++) {
    const name = eligible[i]!;
    const file = join(lane, name);
    const st = state.files.get(name);
    if (st && st.nextAt > now()) {
      res.deferred++;
      continue;
    }
    let contribution: object;
    try {
      if (!statSync(file).isFile()) continue;
      const { filePath: _f, ...c } = parseContribution(file, wolf);
      // The kb parser returns summary + body together as `body`; the hub takes them apart.
      if (c.body.startsWith(`${c.summary}\n\n`)) c.body = c.body.slice(c.summary.length + 2);
      contribution = c;
    } catch (e) {
      // A file that cannot be read or parsed never will be.
      const msg = safeMsg(e, hub.token);
      if (reject(name, undefined, msg, "unparseable")) log(`hub-kb: contribution ${name} is unparseable; moved to rejected/, not retried: ${msg}`);
      else retryLater(name);
      continue;
    }
    try {
      await postContribution(hub, wolf, contribution);
      move(name, "sent");
      state.files.delete(name);
      res.sent++;
      state.auth = { fails: 0, nextAt: 0 };
    } catch (e) {
      const msg = safeMsg(e, hub.token);
      const kind = classify(e);
      // The hub answered and it was not a config refusal: token and URL work.
      if (e instanceof HubHttpError && kind !== "config") state.auth = { fails: 0, nextAt: 0 };
      if (kind === "terminal") {
        const status = (e as HubHttpError).status;
        const r = (e as HubHttpError).details?.reason;
        const reason = typeof r === "string" ? safeMsg(r, hub.token, REASON_MAX) : undefined;
        if (reject(name, status, msg, reason)) {
          log(`hub-kb: contribution ${name} rejected by the hub (${status}); moved to rejected/, not retried: ${msg}`);
          continue;
        }
        const wait = retryLater(name);
        log(`hub-kb: contribution ${name} not sent (will retry in ${Math.round(wait / 1000)}s): ${msg}`);
      } else if (kind === "config") {
        const status = (e as HubHttpError).status;
        const wait = retryLater(name);
        configFailed.add(name);
        // Only a 401 (token-wide), or two distinct files failing this way in one pass, says "everything will fail": trip the breaker.
        // Otherwise (a 403/404/410 can be about this one contribution) carry on with the next file.
        if (status === 401 || configFailed.size >= 2) {
          const fails = state.auth.fails + 1;
          const authWait = backoff(fails);
          state.auth = { fails, nextAt: now() + authWait };
          const left = eligible.length - i - 1;
          res.deferred += left;
          log(`hub-kb: ERROR hub refused ${name} (${status}): check WOLFPACK_HUB_URL and WOLFPACK_HUB_TOKEN, or the wolf is not granted this domain; ${eligible.length - i} file(s) kept, retry in ${Math.round(authWait / 1000)}s: ${msg}`);
          return res;
        }
        log(`hub-kb: contribution ${name} refused (${status}: token/URL/grant); kept, retry in ${Math.round(wait / 1000)}s: ${msg}`);
      } else {
        const wait = retryLater(name);
        log(`hub-kb: contribution ${name} not sent (will retry in ${Math.round(wait / 1000)}s): ${msg}`);
      }
    }
  }
  return res;
}

export interface RunningHubKb {
  sync: KbSync;
  /** One feed pass now (tests). */
  feedNow(): Promise<FeedPass>;
  stop(): void;
}

export function startHubKb(cfg: HubKbEnv, config: WolfConfig, env: NodeJS.ProcessEnv, log: (l: string) => void): RunningHubKb {
  mkdirSync(cfg.mirrorDir, { recursive: true });
  mkdirSync(join(cfg.kbOps, "inbox", config.identity.name), { recursive: true });
  const pollMs = Number(env.WOLFPACK_KB_POLL_MS) > 0 ? Number(env.WOLFPACK_KB_POLL_MS) : 60_000;
  const sync = new KbSync({ hubUrl: cfg.hubUrl, token: cfg.token, mirrorDir: cfg.mirrorDir, layout: "base", pollMs, log: (l) => log(`hub-kb: ${l}`) });
  sync.start();
  sync.setGranted(config.identity.domains);
  const feedMs = Number(env.WOLFPACK_KB_FEED_MS) > 0 ? Number(env.WOLFPACK_KB_FEED_MS) : 5_000;
  let busy = false;
  const state = newFeedState();
  const feedNow = async (): Promise<FeedPass> => {
    if (busy) return { sent: 0, failed: 0, rejected: 0, deferred: 0 };
    busy = true;
    try {
      return await feedInboxToHub(cfg.kbOps, config.identity.name, { baseUrl: cfg.hubUrl, token: cfg.token }, log, { state });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => feedNow().catch((e) => log(`hub-kb: feed pass failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)), feedMs);
  timer.unref();
  log(`hub-kb: mirror ${cfg.mirrorDir} (domains: ${config.identity.domains.join(", ") || "none"}), contributions ${cfg.kbOps}/inbox/${config.identity.name} -> hub`);
  return {
    sync,
    feedNow,
    stop() {
      clearInterval(timer);
      sync.stop();
    },
  };
}
