/**
 * The promote pass wired to the real KB: promote through promoteSessionTopics (only the chosen topics), read each topic's
 * outcome back from its receipts (denTopicStates), resolve routing links through an injected alias resolver.
 * Consolidation never calls this; the triggers do (owner click, graduation, the daily pass).
 */
import { join } from "node:path";
import { denTopicStates, runPromotePass, type PassResult, type PassTrigger, type TopicOutcome } from "@wolfpack/memory";
import type { Engine } from "@wolfpack/engine";
import type { KbRoots } from "@wolfpack/kb/shared";
import { durableSessionTopics, promoteSessionTopics } from "./consolidation.js";

export interface PromoteRunConfig {
  wolfDen: string;
  wolfName: string;
  engine: Engine;
  kbRoots: KbRoots;
  defaultDomain?: string;
  domains?: readonly string[];
  env?: NodeJS.ProcessEnv;
  trigger: PassTrigger;
  /** The kb package's resolveAliasedEntry bound to the roots: id → live entry id, or null. Memory does not import kb internals. */
  resolveEntry: (entryId: string) => string | null;
  onProgress?: (msg: string) => void;
  onEmit?: (c: { id: string; denTopicId: string; domain: string }) => void;
  onArchive?: (a: { id: string; entryId: string | null }) => void;
  now?: Date;
}

export async function runSessionPromotePass(c: PromoteRunConfig): Promise<PassResult> {
  const loc = durableSessionTopics(c.wolfDen);
  const root = join(loc.memoryRoot, loc.sessionId);
  const outcomeOf = (topic: { id: string }): TopicOutcome => {
    const s = denTopicStates(c.wolfDen, c.kbRoots, c.wolfName).find((x) => x.topic.id === topic.id)?.status;
    if (!s) return { kind: "pending" };
    switch (s.kind) {
      case "absorbed": return s.entryId ? { kind: "create", entryIds: [s.entryId] } : { kind: "reject" };
      case "parked": return { kind: "parked" };
      case "awaiting-domain": return { kind: "parked" };
      case "held": return { kind: "held", reason: s.reason };
      default: return { kind: "pending" };
    }
  };
  return runPromotePass({
    den: c.wolfDen,
    root,
    trigger: c.trigger,
    now: c.now,
    promote: async (topics) => {
      await promoteSessionTopics({
        wolfDen: c.wolfDen, wolfName: c.wolfName, engine: c.engine, kbRoots: c.kbRoots,
        defaultDomain: c.defaultDomain, domains: c.domains, env: c.env,
        onlyIds: topics.map((t) => t.id), onProgress: c.onProgress, onEmit: c.onEmit, onArchive: c.onArchive,
      });
    },
    outcomeOf,
    resolveEntry: c.resolveEntry,
    rewriteHeld: async () => false,
  });
}
