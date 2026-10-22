/**
 * work-links — the link-back from graduated work to the KB entries it touched.
 *
 * A graduation sends ordinary contributions whose den topic ids are
 * `work-<domain>-<id>` (the item itself) and `work-<domain>-<id>~<slug>`
 * (splits). When the sweep commits one, it queues a note for that work item:
 *
 *     KB: created kb-wolfpack-X
 *     KB: updated kb-wolfpack-Y
 *
 * Why the sweep: it is the one party that knows what a contribution actually
 * did (created or updated which entry), it runs whether or not the graduating
 * wolf is still online, and it already sits next to the Work API. The note goes
 * to the Work API over HTTP and never blocks the sweep: it is queued in a
 * den-local file first, then posted; while the Work API is unreachable (or
 * not configured) the notes stay queued and are retried by the next tick.
 *
 * The format is machine-readable: `parseKbNotes` reads every `KB:` note of an
 * item back into the entries it created and updated.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";

import { type WorkLink, linkNote } from "../shared/index.js";
export { workIdOfTopic, parseKbNotes, linkNote, type WorkLink } from "../shared/index.js";

const queueFile = (roots: KbRoots) => join(roots.denLocal, "work-links.jsonl");

/** Queue a note (durable, synchronous, cheap). Called under the KB lock. */
export function queueWorkLink(roots: KbRoots, link: WorkLink): void {
  const file = queueFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(link) + "\n");
}

/** Notes waiting to be posted. */
export function pendingWorkLinks(roots: KbRoots): WorkLink[] {
  const file = queueFile(roots);
  if (!existsSync(file)) return [];
  const out: WorkLink[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line) as WorkLink;
      if (l.workId && l.entryId && (l.action === "created" || l.action === "updated")) out.push(l);
    } catch {
      /* a torn line is dropped */
    }
  }
  return out;
}

/** Post one note. Resolves "gone" when the item no longer exists; throws when the Work API is unreachable. */
export type NotePoster = (workId: string, text: string) => Promise<"ok" | "gone">;

/** The Work API over HTTP; null when WORK_ENDPOINT / WORK_TOKEN are not both set. */
export function httpNotePoster(
  endpoint = process.env.WORK_ENDPOINT,
  token = process.env.WORK_TOKEN,
  fetchImpl: typeof fetch = fetch,
): NotePoster | null {
  if (!endpoint || !token) return null;
  const base = endpoint.replace(/\/$/, "");
  return async (workId, text) => {
    const res = await fetchImpl(`${base}/work/${encodeURIComponent(workId)}`, {
      method: "PATCH",
      headers: { "X-API-Key": token, "Content-Type": "application/json" },
      body: JSON.stringify({ note: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 400) return "gone"; // deleted (or not an item): nothing to note
    if (!res.ok) throw new Error(`Work API PATCH ${workId}: HTTP ${res.status}`);
    return "ok";
  };
}

/**
 * Post the queued notes in order. Stops at the first unreachable-API error
 * (the rest stay queued); a note for a deleted item is dropped. Returns what
 * was sent and what remains. Callers hold the KB lock (the file has one writer).
 */
export async function flushWorkLinks(
  roots: KbRoots,
  post: NotePoster | null,
  notify?: (msg: string) => void,
): Promise<{ sent: number; pending: number }> {
  const queued = pendingWorkLinks(roots);
  if (queued.length === 0 || !post) return { sent: 0, pending: queued.length };
  let sent = 0;
  let i = 0;
  for (; i < queued.length; i++) {
    try {
      await post(queued[i].workId, linkNote(queued[i]));
      sent++;
    } catch (err) {
      notify?.(`work links: Work API unreachable, ${queued.length - i} note(s) stay queued — ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      break;
    }
  }
  const rest = queued.slice(i);
  atomicWrite(queueFile(roots), rest.map((l) => JSON.stringify(l)).join("\n") + (rest.length ? "\n" : ""));
  return { sent, pending: rest.length };
}

/** True when notes are queued (one small file read; the idle tick checks this before taking the lock). */
export const hasPendingWorkLinks = (roots: KbRoots): boolean => pendingWorkLinks(roots).length > 0;
