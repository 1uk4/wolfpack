/**
 * The promote pass wired to the real KB: promote through promoteSessionTopics (only the chosen topics), read each topic's
 * outcome back from its receipts (denTopicStates), resolve routing links through an injected alias resolver.
 * Consolidation never calls this; the triggers do (owner click, graduation, the daily pass).
 */
import { join } from "node:path";
import { ConsolidationResultSchema, denTopicStates, readTopics, runPromotePass, writeTopic, type ConsolidateResult, type PassResult, type PassTrigger, type TopicFile, type TopicOutcome } from "@wolfpack/memory";
import { CONSOLIDATE_SYSTEM, type Engine } from "@wolfpack/engine";
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

/** The pass result plus the real promote result (counts, per-topic details) when the pass promoted anything. */
export type SessionPassResult = PassResult & { promoteResult?: ConsolidateResult };

/**
 * One forced rewrite of a held topic: the model gets the distill findings and must rewrite the topic so it states
 * decisions and facts, not a log. True when the topic file was replaced; false (topic untouched) on any failure.
 */
export async function rewriteHeldTopic(engine: Engine, root: string, topic: TopicFile, reason: string): Promise<boolean> {
  try {
    const res = await engine.call("consolidate", ConsolidationResultSchema, {
      system: CONSOLIDATE_SYSTEM,
      prompt: `The KB held this topic back. Findings: ${reason}\n\nRewrite it once so the findings no longer apply: keep decisions, facts and reasons, drop narration. Return one merge action with the same id.\n\n### ${topic.id} — ${topic.title}\nSummary: ${topic.summary}\n\n${topic.body}`,
    });
    const r = res.actions.find((a) => a.action !== "skip" && a.result?.id === topic.id)?.result;
    if (!r || !r.body.trim()) return false;
    const updated = new Date().toISOString().replace("T", " ").slice(0, 16);
    writeTopic(root, { id: topic.id, title: r.title, summary: r.summary, updated, body: r.body, domain: topic.domain, sources: topic.sources, lastNote: topic.lastNote, keepLocal: topic.keepLocal });
    return readTopics(root).some((t) => t.id === topic.id);
  } catch {
    return false;
  }
}

export async function runSessionPromotePass(c: PromoteRunConfig): Promise<SessionPassResult> {
  let promoteResult: ConsolidateResult | undefined;
  const loc = durableSessionTopics(c.wolfDen);
  const root = join(loc.memoryRoot, loc.sessionId);
  const outcomeOf = (topic: { id: string }): TopicOutcome => {
    const s = denTopicStates(c.wolfDen, c.kbRoots, c.wolfName).find((x) => x.topic.id === topic.id)?.status;
    if (!s) return { kind: "pending" };
    switch (s.kind) {
      case "absorbed": return s.entryIds.length ? { kind: "create", entryIds: s.entryIds } : { kind: "reject" };
      case "parked": return { kind: "parked" };
      case "awaiting-domain": return { kind: "parked" };
      case "held": return { kind: "held", reason: s.reason };
      default: return { kind: "pending" };
    }
  };
  const pass = await runPromotePass({
    den: c.wolfDen,
    root,
    trigger: c.trigger,
    now: c.now,
    promote: async (topics, targets) => {
      promoteResult = await promoteSessionTopics({
        wolfDen: c.wolfDen, wolfName: c.wolfName, engine: c.engine, kbRoots: c.kbRoots,
        defaultDomain: c.defaultDomain, domains: c.domains, env: c.env,
        onlyIds: topics.map((t) => t.id), targets, onProgress: c.onProgress, onEmit: c.onEmit, onArchive: c.onArchive,
      });
    },
    outcomeOf,
    resolveEntry: c.resolveEntry,
    rewriteHeld: (t, reason) => rewriteHeldTopic(c.engine, root, t, reason),
  });
  return { ...pass, ...(promoteResult ? { promoteResult } : {}) };
}
