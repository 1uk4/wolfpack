import type { ThreadMessage } from "./schemas.js";

/** Largest page a client may ask for (`limit` above it is clamped). */
export const MAX_PAGE_LIMIT = 500;

export interface PageOptions {
  /** Page size. Absent = no paging (the whole transcript, the pre-paging behaviour). */
  limit?: number;
  /** Cursor: a message id; the page ends just before it (older messages). Absent = the newest page. */
  before?: string;
  /** Index of the first message after the newest compaction; the newest page never starts later than this. */
  compactionIndex?: number;
  /** Tool call ids of pending cards; the newest page always starts early enough to include their messages. */
  requiredCallIds?: readonly string[];
}

export interface Page {
  /** [start, end) of the slice in the full list. */
  start: number;
  end: number;
  hasMore: boolean;
  /** Id of the oldest message in the page: pass as `before` for the next older page. Absent when empty. */
  cursor?: string;
}

/**
 * Pure page maths over the full ordered message list. Newest page (`before` absent): the last `limit` messages, or
 * everything since the newest compaction, whichever is larger, extended further back to hold any pending card's message.
 * Older pages (`before` set): exactly the `limit` messages before the cursor (unknown cursor = empty, no more).
 */
export function pageRange(messages: readonly ThreadMessage[], opts: PageOptions): Page {
  const n = messages.length;
  const limit = opts.limit === undefined ? undefined : Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(opts.limit)));
  let start = 0;
  let end = n;
  if (limit !== undefined) {
    if (opts.before !== undefined) {
      end = messages.findIndex((m) => m.id === opts.before);
      if (end < 0) return { start: 0, end: 0, hasMore: false };
      start = Math.max(0, end - limit);
    } else {
      start = Math.max(0, n - limit);
      if (opts.compactionIndex !== undefined) start = Math.min(start, Math.max(0, opts.compactionIndex));
      const need = new Set(opts.requiredCallIds ?? []);
      if (need.size) {
        const first = messages.findIndex((m) => m.tools?.some((t) => need.has(t.callId)));
        if (first >= 0) start = Math.min(start, first);
      }
    }
  }
  const first = messages[start];
  return { start, end, hasMore: start > 0, ...(first && limit !== undefined ? { cursor: first.id } : {}) };
}
