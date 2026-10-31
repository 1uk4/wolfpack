/**
 * Feeds contribution files into the hub link. The memory extension's `emitDelta` keeps writing `<kbOps>/inbox/<wolf>/<topic>-<hash10>.md`
 * exactly as before (Syncthing still works); when a hub link is configured workerd scans those lanes for the wolves it hosts and
 * queues each file in the durable outbox. ONLY a file that was actually queued leaves the lane (moved to `<lane>/sent/`, never
 * overwriting an existing file there). Anything else stays untouched in the lane so the Syncthing path keeps working during shadow mode:
 * a file that fails parse, round-trip, hash or size checks is logged once per path (in memory) and left alone; an I/O error is logged
 * and retried on the next scan. There is deliberately no `_bad/` quarantine in the feed.
 *
 * Exactly-once: the outbox id is deterministic (`<wolf>.<topic>-<hash10>`, or a hashed topic when that would not fit), so a crash between
 * the enqueue and the move re-enqueues the same id, which the outbox (still queued) or the hub (duplicate ack) absorbs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { renderContribution } from "@wolfpack/kb/client";
import { parseContribution } from "@wolfpack/kb/librarian/intake";
import { contentHash, hashTag } from "@wolfpack/kb/shared";
import { OutboxError } from "./outbox.js";

const WOLF_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Same rules as the outbox's idempotency id. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface FeedTarget {
  /** Queue durably under an idempotency id; throws OutboxError when it cannot (too large, full). */
  contribute(wolf: string, contribution: Record<string, unknown>, id: string): unknown;
}

export interface FeedResult {
  queued: number;
  /** Files left in the lane because a check failed (logged once per path). */
  skipped: number;
}

/** Deterministic idempotency id; falls back to a hash of the topic when the plain form is too long or has odd characters. */
export function feedId(wolf: string, topic: string, hash: string): string {
  const tag = hashTag(hash);
  const plain = `${wolf}.${topic}-${tag}`;
  if (ID_RE.test(plain)) return plain;
  return `${wolf}.${createHash("sha256").update(topic).digest("hex").slice(0, 16)}-${tag}`;
}

/** `sent/<name>`, or `sent/<name>.<n>` when that name is taken. */
function sentName(dir: string, name: string): string {
  let n = 0;
  let cand = name;
  while (existsSync(join(dir, cand))) cand = `${name}.${++n}`;
  return cand;
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Why the feed must not run, if so: explicitly disabled (WORKERD_FEED=0/false/off), or `<kbOps>/inbox` is the hub's own inbox root
 * (workerd and hubd on one host sharing a lane; moving files out of it would eat the hub's inbox).
 */
export function feedDisabledReason(kbOps: string, env: Record<string, string | undefined>, hubInboxRoot?: string): string | undefined {
  if (/^(0|false|off|no)$/i.test((env.WORKERD_FEED ?? "").trim())) return "disabled by WORKERD_FEED";
  const hub = hubInboxRoot ?? (env.HUBD_INBOX_ROOT?.trim() || undefined);
  if (hub) {
    const a = real(join(kbOps, "inbox"));
    const b = real(hub);
    if (a && b && a === b) return `${join(kbOps, "inbox")} is the hub's inbox root (same lane); set WORKERD_FEED=0 on a host that runs hubd`;
  }
  return undefined;
}

/** One pass over the inbox lanes of `wolves`. Never throws. `warned` carries the log-once memory across passes. */
export function feedContributions(
  kbOps: string,
  wolves: string[],
  target: FeedTarget,
  log: (m: string) => void = () => {},
  warned: Set<string> = new Set(),
): FeedResult {
  const res: FeedResult = { queued: 0, skipped: 0 };
  // Newly refused files of the lane being scanned; reported as ONE summary line per lane per scan (each file only once per process).
  let fresh: string[] = [];
  let freshWhy: string[] = [];
  const leave = (file: string, why: string): void => {
    res.skipped++;
    if (warned.has(file)) return;
    warned.add(file);
    fresh.push(file);
    freshWhy.push(why);
  };
  for (const wolf of wolves) {
    if (!WOLF_RE.test(wolf)) continue;
    const lane = join(kbOps, "inbox", wolf);
    fresh = [];
    freshWhy = [];
    let names: string[];
    try {
      names = readdirSync(lane).sort();
    } catch {
      continue; // no lane yet
    }
    for (const name of names) {
      // dotfiles (incl. dot temp names), emitDelta's `<file>.tmp-<pid>-<ms>` temp (not .md), _processed, _bad, sent, anything else
      if (name.startsWith(".") || !name.endsWith(".md") || /\.tmp-/.test(name)) continue;
      const file = join(lane, name);
      let text: string;
      try {
        if (!statSync(file).isFile()) continue;
        text = readFileSync(file, "utf-8");
      } catch (e) {
        // I/O error (EACCES, EMFILE, a race with the mover): not a bad file. Retry next scan; log once per path and error code.
        const key = `io:${file}:${(e as NodeJS.ErrnoException).code ?? ""}`;
        if (!warned.has(key)) {
          warned.add(key);
          log(`[workerd] contribution ${JSON.stringify(file)} could not be read, will retry: ${(e as Error).message}`);
        }
        continue;
      }
      let id: string;
      let contribution: Record<string, unknown>;
      try {
        let parsed: ReturnType<typeof parseContribution>;
        try {
          parsed = parseContribution(file, wolf);
        } catch (pe) {
          throw new Error(`parse check failed: ${(pe as Error).message}`);
        }
        const { filePath: _filePath, ...c } = parsed;
        // The kb parser returns summary + body together as `body` (the file is `summary \n\n body`); the link carries them apart.
        if (c.body.startsWith(`${c.summary}\n\n`)) c.body = c.body.slice(c.summary.length + 2);
        // Trailing whitespace is not content (the parser trims the body), so only that difference is tolerated.
        if (renderContribution(c).trimEnd() !== text.trimEnd()) throw new Error("round-trip check failed: file does not round-trip through parse and render (it would arrive changed)");
        if (contentHash(c.body) !== c.contentHash) throw new Error("hash check failed: content_hash does not match the body (the hub would refuse it)");
        id = feedId(wolf, parsed.denTopicId, parsed.contentHash);
        contribution = c as unknown as Record<string, unknown>;
      } catch (e) {
        leave(file, e instanceof Error ? e.message : String(e));
        continue;
      }
      try {
        target.contribute(wolf, contribution, id);
      } catch (e) {
        if (e instanceof OutboxError && (e.code === "too_large" || e.code === "bad_id")) leave(file, `size check failed: ${e.message}`);
        else {
          const key = `q:${file}`;
          if (!warned.has(key)) {
            warned.add(key);
            log(`[workerd] contribution ${JSON.stringify(file)} not queued yet: ${(e as Error).message}`); // outbox full / disk: retried next scan
          }
        }
        continue;
      }
      try {
        const sent = join(lane, "sent");
        mkdirSync(sent, { recursive: true });
        renameSync(file, join(sent, sentName(sent, name)));
        res.queued++;
      } catch (e) {
        log(`[workerd] contribution ${JSON.stringify(file)} queued but not moved to sent/: ${(e as Error).message}`); // re-queue next scan is a no-op
      }
    }
    if (fresh.length) {
      log(`[workerd] feed: ${fresh.length} contribution(s) left in place in ${lane} (not sent; first: ${basename(fresh[0]!)}: ${freshWhy[0]})`);
    }
  }
  return res;
}
