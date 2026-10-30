/**
 * Feeds contribution files into the hub link. The memory extension's `emitDelta` keeps writing `<kbOps>/inbox/<wolf>/<topic>-<hash10>.md`
 * exactly as before (Syncthing still works); when a hub link is configured workerd scans those lanes for the wolves it hosts and
 * queues each file in the durable outbox. A queued file moves to `<lane>/sent/`, so it is not read again and Dewey's local sweep (which
 * reads only the lane's top level) never sees it.
 *
 * Exactly-once: the outbox id is `<wolf>.<topic>-<hash10>`, stable for the file. Crash after the enqueue and before the move: the next scan
 * enqueues the same id again, which the outbox (still queued) or the hub (already stored: duplicate ack) absorbs.
 * A file that does not parse, or does not re-render byte for byte, goes to `<lane>/_bad/` with a `.reason.txt` and is logged once.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderContribution } from "@wolfpack/kb/client";
import { parseContribution } from "@wolfpack/kb/librarian";
import { hashTag } from "@wolfpack/kb/shared";
import { OutboxError } from "./outbox.js";

const WOLF_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface FeedTarget {
  /** Queue durably under an idempotency id; throws OutboxError when it cannot (too large, full). */
  contribute(wolf: string, contribution: Record<string, unknown>, id: string): unknown;
}

export interface FeedResult {
  queued: number;
  bad: number;
}

function quarantine(file: string, lane: string, name: string, reason: string, log: (m: string) => void): void {
  try {
    const dir = join(lane, "_bad");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, name);
    writeFileSync(`${dest}.reason.txt`, `${reason}\n`);
    renameSync(file, dest);
    log(`[workerd] contribution ${JSON.stringify(name)} moved to _bad/: ${reason}`);
  } catch (e) {
    log(`[workerd] contribution ${JSON.stringify(name)} is bad (${reason}) and could not be moved: ${(e as Error).message}`);
  }
}

/** One pass over the inbox lanes of `wolves`. Never throws. */
export function feedContributions(kbOps: string, wolves: string[], target: FeedTarget, log: (m: string) => void = () => {}): FeedResult {
  const res: FeedResult = { queued: 0, bad: 0 };
  for (const wolf of wolves) {
    if (!WOLF_RE.test(wolf)) continue;
    const lane = join(kbOps, "inbox", wolf);
    let names: string[];
    try {
      names = readdirSync(lane).sort();
    } catch {
      continue; // no lane yet
    }
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".md")) continue; // dotfiles, _processed, _bad, sent, anything else
      const file = join(lane, name);
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      let id: string;
      let contribution: Record<string, unknown>;
      try {
        const parsed = parseContribution(file, wolf);
        // The kb parser returns summary + body together as `body` (the file is `summary \n\n body`); the link carries them apart.
        const { filePath: _filePath, ...c } = parsed;
        if (c.body.startsWith(`${c.summary}\n\n`)) c.body = c.body.slice(c.summary.length + 2);
        if (renderContribution(c) !== readFileSync(file, "utf-8")) throw new Error("file does not round-trip through parse and render (it would arrive changed)");
        id = `${wolf}.${parsed.denTopicId}-${hashTag(parsed.contentHash)}`;
        contribution = c as unknown as Record<string, unknown>;
      } catch (e) {
        res.bad++;
        quarantine(file, lane, name, e instanceof Error ? e.message : String(e), log);
        continue;
      }
      try {
        target.contribute(wolf, contribution, id);
      } catch (e) {
        if (e instanceof OutboxError && /bytes; the limit|bad idempotency id/.test(e.message)) {
          res.bad++;
          quarantine(file, lane, name, e.message, log);
        } else {
          log(`[workerd] contribution ${JSON.stringify(name)} not queued yet: ${(e as Error).message}`); // outbox full / disk: retried next scan
        }
        continue;
      }
      try {
        const sent = join(lane, "sent");
        mkdirSync(sent, { recursive: true });
        renameSync(file, join(sent, name));
        res.queued++;
      } catch (e) {
        log(`[workerd] contribution ${JSON.stringify(name)} queued but not moved to sent/: ${(e as Error).message}`); // re-queue next scan is a no-op
      }
    }
  }
  return res;
}
