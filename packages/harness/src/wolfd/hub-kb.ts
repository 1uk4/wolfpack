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
 *         POSTs each file to hubd `/v1/contributions`; only a 2xx moves the file to `<lane>/sent/`. A failure leaves it for the next scan.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { KbSync } from "@wolfpack/kb/sync";
import { parseContribution } from "@wolfpack/kb/librarian/intake";
import { postContribution } from "@wolfpack/memory";
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
}

/** One pass over `<kbOps>/inbox/<wolf>`: POST each contribution file to the hub; move the accepted ones to `sent/`. Never throws. */
export async function feedInboxToHub(kbOps: string, wolf: string, hub: { baseUrl: string; token: string; fetch?: typeof fetch }, log: (l: string) => void): Promise<FeedPass> {
  const res: FeedPass = { sent: 0, failed: 0 };
  const lane = join(kbOps, "inbox", wolf);
  let names: string[];
  try {
    names = readdirSync(lane).sort();
  } catch {
    return res;
  }
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".md") || /\.tmp-/.test(name)) continue;
    const file = join(lane, name);
    try {
      if (!statSync(file).isFile()) continue;
      readFileSync(file, "utf-8");
      const { filePath: _f, ...c } = parseContribution(file, wolf);
      // The kb parser returns summary + body together as `body`; the hub takes them apart.
      if (c.body.startsWith(`${c.summary}\n\n`)) c.body = c.body.slice(c.summary.length + 2);
      await postContribution(hub, wolf, c);
      const sent = join(lane, "sent");
      mkdirSync(sent, { recursive: true });
      let n = 0;
      let cand = name;
      while (existsSync(join(sent, cand))) cand = `${name}.${++n}`;
      renameSync(file, join(sent, cand));
      res.sent++;
    } catch (e) {
      res.failed++;
      log(`hub-kb: contribution ${name} not sent (will retry): ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
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
  const feedNow = async (): Promise<FeedPass> => {
    if (busy) return { sent: 0, failed: 0 };
    busy = true;
    try {
      return await feedInboxToHub(cfg.kbOps, config.identity.name, { baseUrl: cfg.hubUrl, token: cfg.token }, log);
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
