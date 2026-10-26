/**
 * Read side of a conversation for extensions: what kind of conversation this is (root, fork, task-owned) and the
 * messages it appended itself, in order. pi-durable's `afterResponse` HookApi exposes neither the conversation record
 * nor its history, so the engine registers a reader over the opened Harness, keyed by the wolf's den, and the
 * durable adapter hands the bound form to hooks as `HookContext.conversation`.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { ConversationClass, ConversationMessage } from "../extension-api.js";

const ctx = BACKGROUND_CONTEXT;
const PAGE = 200;

export interface ConversationReader {
  /** Classify by the immutable ConversationRecord. `undefined` for an unknown id. Cached: records never change. */
  classify(conversationId: number): Promise<ConversationClass | undefined>;
  /**
   * Messages (user, assistant, tool results) this conversation appended itself with entry id > `afterEntryId`, oldest
   * first. A fork's inherited history is excluded, so a fork reads only what happened after the fork point.
   */
  messagesSince(conversationId: number, afterEntryId?: number): Promise<ConversationMessage[]>;
  /** Run `fn` when the engine closes. */
  onClose(fn: () => void): void;
  /** Called by the engine on close. */
  close(): void;
}

export function createConversationReader(harness: Harness): ConversationReader {
  const classes = new Map<number, ConversationClass>();
  const closers = new Set<() => void>();

  async function classify(id: number): Promise<ConversationClass | undefined> {
    const hit = classes.get(id);
    if (hit) return hit;
    const record = await harness.commit((tx) => tx.conversation(id as never), ctx);
    if (!record) return undefined;
    let cls: ConversationClass;
    if (record.owner) {
      cls = { kind: "task", taskId: Number(record.owner.taskId), ownerConversationId: Number(record.owner.conversationId) };
    } else if (record.parent) {
      const parent = await classify(Number(record.parent.conversationId));
      // A fork of a task-owned conversation is a branch of a subagent's work: it stays task (quiet, no capture,
      // no binding). Any other fork resolves to the root of its lineage.
      const lineageRoot = parent?.kind === "fork" ? parent.lineageRoot : Number(record.parent.conversationId);
      cls = parent?.kind === "task" ? parent : { kind: "fork", parentConversationId: Number(record.parent.conversationId), forkedAt: Number(record.parent.at), lineageRoot };
    } else {
      cls = { kind: "root" };
    }
    classes.set(id, cls);
    return cls;
  }

  async function messagesSince(id: number, afterEntryId = 0): Promise<ConversationMessage[]> {
    const conv: Conversation | undefined = await harness.conversation(id as never, ctx);
    if (!conv) return [];
    const out: ConversationMessage[] = [];
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    do {
      const page = await conv.entries({ order: "ascending", minEntryId: (afterEntryId + 1) as never }, PAGE, cursor, ctx);
      for (const entry of page.items) {
        // entries() is fork-aware: skip what the parent appended and this conversation inherited.
        if (Number(entry.conversationId) !== id) continue;
        for (const message of entry.model ?? []) out.push({ entryId: Number(entry.id), message });
      }
      cursor = page.next;
    } while (cursor);
    return out;
  }

  return {
    classify,
    messagesSince,
    onClose: (fn) => void closers.add(fn),
    close: () => {
      for (const fn of closers) {
        try { fn(); } catch { /* best effort */ }
      }
      closers.clear();
    },
  };
}

// ─── Registry (per den) ────────────────────────────────────────────────────

const readers = new Map<string, ConversationReader>();

/** One engine per den: registering a second reader for the same den replaces the first (and warns). */
export function registerConversationReader(den: string, reader: ConversationReader): () => void {
  if (readers.has(den)) console.warn(`[engine] conversation reader for ${den} replaced: two engines open on one den`);
  readers.set(den, reader);
  return () => {
    if (readers.get(den) === reader) readers.delete(den);
  };
}

export function conversationReaderFor(den: string): ConversationReader | undefined {
  return readers.get(den);
}
