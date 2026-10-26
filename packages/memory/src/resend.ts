/**
 * Resend: the den half of a Dewey rebuild from scratch (/wolf:resend-all and
 * the CLI's --emit-den). Both callers go through here, so the set they send
 * and the force they pass cannot drift apart.
 */
import { readResendTopics, type ArchivedDenTopic, type DenTopic } from "./den.js";
import { promoteTopics, type PromoteOptions, type PromoteStats } from "./distill.js";

export interface ResendSet {
  /** Absorbed by Dewey: latest stint per id, rejects included, oldest absorbed first. */
  archived: ArchivedDenTopic[];
  pending: DenTopic[];
  /** Send order: archived, then pending. */
  topics: DenTopic[];
}

export function readResendSet(denRoot: string): ResendSet {
  const { archived, pending } = readResendTopics(denRoot);
  return { archived, pending, topics: [...archived, ...pending] };
}

/**
 * Distill and emit the whole set with force: unchanged bodies reuse stored
 * distill outputs and are re-sent despite emitted.json.
 *
 * No onHold writeback here, on purpose: a topic distill holds back stays as it
 * is. Writing `promotable: false` would edit an archived stint, which is a
 * record of what Dewey absorbed, not a live den topic.
 */
export function resendDenTopics(
  set: ResendSet,
  opts: Omit<PromoteOptions, "force" | "onHold">,
  promote: typeof promoteTopics = promoteTopics
): Promise<PromoteStats> {
  return promote(
    set.topics
      .filter((t) => t.promotable) // held in the den as a session log
      .map((t) => ({ id: t.id, title: t.title, summary: t.summary, body: t.body, change: "create" as const })),
    { ...opts, force: true }
  );
}
