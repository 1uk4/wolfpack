/**
 * The owner of a subagent's conversation. A pi-durable conversation owned by a task is the durable way to say "this
 * is a child of that thread": memory skips it (no observations) and resolves its binding read-only, and the store
 * keeps the edge across restarts. The task does no work: it parks until its conversation is aborted or wolfd stops.
 * It is a background task of the PARENT conversation, so aborting the parent's turn leaves its children running.
 */
import { defineExtension, defineTask } from "@earendil-works/pi-durable";

export const SubagentOwner = defineTask<Record<string, never>, { phase: "park" }, null>({
  name: "wolfd.subagent-owner",
  version: 1,
  initial: () => ({ phase: "park" }),
  phases: {
    park: async (_task, runtime, c) => runtime.sleepUntil(runtime.now() + 1e12, { phase: "park" }, c),
  },
  abort: async (_task, runtime, c) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
});

export const subagentOwnerExtension = defineExtension({ name: "wolfd-subagent-owner", tasks: [SubagentOwner] });
