/**
 * Turn-scoped caller context for Work API writes: which wolfd thread (and subagent) is making the call.
 * wolfd runs a thread's turn inside `runInTurnContext`; HttpWorkRecordStore reads it and adds the
 * `x-wolfpack-thread-id` / `x-wolfpack-subagent` headers so the hub can attribute the write on the live pack map.
 * Outside a turn (background consolidation, CLI) nothing is set and no header is sent.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnContext {
  threadId: string;
  /** The subagent's name, when this thread is a subagent child. */
  subagent?: string;
}

export const THREAD_ID_HEADER = "x-wolfpack-thread-id";
export const SUBAGENT_HEADER = "x-wolfpack-subagent";

// One store per process, on globalThis: a bundled copy of @wolfpack/memory inside an extension shares it with wolfd.
const KEY = Symbol.for("wolfpack.turnContext");
const g = globalThis as { [KEY]?: AsyncLocalStorage<TurnContext> };
const store: AsyncLocalStorage<TurnContext> = (g[KEY] ??= new AsyncLocalStorage<TurnContext>());

export const runInTurnContext = <T>(ctx: TurnContext, fn: () => T): T => store.run(ctx, fn);
export const currentTurnContext = (): TurnContext | undefined => store.getStore();

/** The actor headers for the current turn, or none. */
export function turnActorHeaders(): Record<string, string> {
  const c = store.getStore();
  if (!c?.threadId) return {};
  return { [THREAD_ID_HEADER]: c.threadId, ...(c.subagent ? { [SUBAGENT_HEADER]: c.subagent } : {}) };
}
