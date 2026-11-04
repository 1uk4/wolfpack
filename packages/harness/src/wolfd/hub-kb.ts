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
 *         a terminal 4xx moves the file to `<lane>/rejected/` (+ `.reason.json`) and is never retried; 401/403 (config) and transient
 *         failures (network, 5xx, 408, 429) leave the file in place and retry it with per-file exponential backoff (5 s .. 5 min).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KbSync } from "@wolfpack/kb/sync";
import { parseContribution } from "@wolfpack/kb/librarian/intake";
import { HubRejectedError, postContribution } from "@wolfpack/memory";
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
  /** Moved to `rejected/` (terminal 4xx). */
  rejected: number;
  /** Skipped this pass because the file is backing off. */
  deferred: number;
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 5 * 60_000;

/** Per-file retry state, kept by the caller across passes. */
export type FeedState = Map<string, { fails: number; nextAt: number }>;

export type Failure = "terminal" | "auth" | "retry";

/** What to do with a failed post: 401/403 = config problem (keep, loud); other 4xx except 408/429 = the hub will never accept it; the rest = transient. */
export function classify(e: unknown): Failure {
  const status = e instanceof HubRejectedError ? e.status : undefined;
  if (status === undefined) return "retry";
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "terminal";
  return "retry";
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
  const state = opts.state ?? new Map();
  const now = opts.now ?? Date.now;
  const lane = join(kbOps, "inbox", wolf);
  let names: string[];
  try {
    names = readdirSync(lane).sort();
  } catch {
    return res;
  }
  const move = (name: string, dir: string): string => {
    const dest = join(lane, dir);
    mkdirSync(dest, { recursive: true });
    let n = 0;
    let cand = name;
    while (existsSync(join(dest, cand))) cand = `${name}.${++n}`;
    renameSync(join(lane, name), join(dest, cand));
    return cand;
  };
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".md") || /\.tmp-/.test(name)) continue;
    const file = join(lane, name);
    const st = state.get(name);
    if (st && st.nextAt > now()) {
      res.deferred++;
      continue;
    }
    try {
      if (!statSync(file).isFile()) continue;
      readFileSync(file, "utf-8");
      const { filePath: _f, ...c } = parseContribution(file, wolf);
      // The kb parser returns summary + body together as `body`; the hub takes them apart.
      if (c.body.startsWith(`${c.summary}\n\n`)) c.body = c.body.slice(c.summary.length + 2);
      await postContribution(hub, wolf, c);
      move(name, "sent");
      state.delete(name);
      res.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      const kind = classify(e);
      if (kind === "terminal") {
        const status = (e as HubRejectedError).status;
        const cand = move(name, "rejected");
        const details = (e as HubRejectedError).details;
        const reason = details && typeof details === "object" && typeof (details as { reason?: unknown }).reason === "string" ? (details as { reason: string }).reason : undefined;
        try {
          writeFileSync(join(lane, "rejected", `${cand}.reason.json`), JSON.stringify({ status, message: msg, ...(reason ? { reason } : {}), at: new Date(now()).toISOString() }, null, 2) + "\n");
        } catch {}
        state.delete(name);
        res.rejected++;
        log(`hub-kb: contribution ${name} rejected by the hub (${status}); moved to rejected/, not retried: ${msg}`);
        continue;
      }
      const fails = (st?.fails ?? 0) + 1;
      const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (fails - 1));
      state.set(name, { fails, nextAt: now() + wait });
      res.failed++;
      if (kind === "auth") log(`hub-kb: ERROR hub refused credentials for contribution ${name} (${(e as HubRejectedError).status}): check WOLFPACK_HUB_TOKEN; file kept, retry in ${Math.round(wait / 1000)}s: ${msg}`);
      else log(`hub-kb: contribution ${name} not sent (will retry in ${Math.round(wait / 1000)}s): ${msg}`);
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
  const state: FeedState = new Map();
  const feedNow = async (): Promise<FeedPass> => {
    if (busy) return { sent: 0, failed: 0, rejected: 0, deferred: 0 };
    busy = true;
    try {
      return await feedInboxToHub(cfg.kbOps, config.identity.name, { baseUrl: cfg.hubUrl, token: cfg.token }, log, { state });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void feedNow(), feedMs);
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
