/**
 * emitDelta — the wolf's entire WRITE footprint. Deterministic, no LLM.
 *
 * Replaces the old per-topic `claimCheck` LLM call in the memory package's
 * consolidate.ts. Called once per updated den topic during /wolf:promote.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import {
  type Contribution,
  contentHash,
  inboxDir,
  now,
  type KbRoots,
} from "../shared/index.js";

export interface EmitDeltaInput {
  roots: KbRoots;
  wolf: string;
  host?: string;
  denTopicId: string;
  change: "create" | "merge";
  domainHint: string;
  summary: string;
  body: string;
  session?: string;
}

/**
 * Write a contribution to librarian-ops/inbox/<wolf>/, but ONLY if the content
 * actually changed since the last emit for this topic (hash guard). Returns the
 * contribution written, or null if skipped as unchanged.
 */
export function emitDelta(input: EmitDeltaInput): Contribution | null {
  const { roots, wolf } = input;
  const dir = inboxDir(roots, wolf);
  mkdirSync(dir, { recursive: true });

  const hash = contentHash(input.body);
  const prevHash = readLastHash(dir, input.denTopicId);
  if (prevHash === hash) return null; // unchanged re-promotion → no-op

  const contribution: Contribution = {
    from: wolf,
    host: input.host,
    denTopicId: input.denTopicId,
    change: input.change,
    contentHash: hash,
    prevHash,
    domainHint: input.domainHint,
    summary: input.summary,
    session: input.session,
    submitted: now(),
    body: input.body,
  };

  const file = join(dir, `${input.denTopicId}-${hash.slice(7, 17)}.md`);
  atomicWrite(file, render(contribution));
  return contribution;
}

/** Find the most recent hash emitted for a topic (scan inbox filenames/bodies). */
function readLastHash(dir: string, denTopicId: string): string | null {
  // TODO: maintain a per-wolf local hash map (den/kb/emitted.json) rather than
  // scanning, so dedup survives inbox drain. Scaffold reads nothing for now.
  if (!existsSync(dir)) return null;
  return null;
}

function render(c: Contribution): string {
  const fm = [
    "---",
    `from: ${c.from}`,
    c.host ? `host: ${c.host}` : null,
    `den_topic_id: ${c.denTopicId}`,
    `change: ${c.change}`,
    `content_hash: ${c.contentHash}`,
    `prev_hash: ${c.prevHash ?? "null"}`,
    `domain_hint: ${c.domainHint}`,
    c.session ? `session: ${c.session}` : null,
    `submitted: ${c.submitted}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${fm}\n\n${c.summary}\n\n${c.body}\n`;
}
