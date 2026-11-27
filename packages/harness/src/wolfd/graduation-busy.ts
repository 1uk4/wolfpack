/**
 * Is the feature thread of a work item busy? A graduation waits while its feature thread has a turn in progress or a
 * sub-agent running (queued, running or waiting), so the owner never graduates work an agent is still changing.
 * Pure: the server lists its threads, this decides.
 */
export interface FeatureThreadState {
  kind: string;
  boundWorkItem?: string;
  conversationId: number | string;
  /** A turn is in progress on the thread itself. */
  running: boolean;
  /** Names of the thread's sub-agents that are queued, running or waiting. */
  liveChildren: string[];
}

/** A short reason when a thread bound to `workItemId` is busy, undefined when idle or when none exists. `exceptConversation` leaves out that thread's own turn (the caller's), never its sub-agents. */
export function runningReasonFor(workItemId: string, threads: FeatureThreadState[], exceptConversation?: number | string): string | undefined {
  for (const t of threads) {
    if (t.kind !== "feature" || t.boundWorkItem !== workItemId) continue;
    if (t.running && (exceptConversation === undefined || String(t.conversationId) !== String(exceptConversation))) return "a turn is in progress";
    if (t.liveChildren.length) return `${t.liveChildren.length} sub-agent${t.liveChildren.length === 1 ? "" : "s"} running (${t.liveChildren.slice(0, 3).join(", ")})`;
  }
  return undefined;
}
