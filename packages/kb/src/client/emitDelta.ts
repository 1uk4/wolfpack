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

/** Wolf-local map denTopicId → last-emitted content hash. Lives in the wolf's
 *  non-synced den/kb so dedup survives inbox drain (the sweep moves inbox files
 *  to _processed, so the inbox itself can't be the dedup source). */
function emittedMapPath(roots: KbRoots): string {
  return join(roots.denLocal, "emitted.json");
}

function readEmittedMap(roots: KbRoots): Record<string, string> {
  const p = emittedMapPath(roots);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

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
  // Temporal provenance (crawl ingestion). All optional.
  sourceCreated?: string;
  sourceUpdated?: string;
  dateBasis?: Contribution["dateBasis"];
  dateConfidence?: Contribution["dateConfidence"];
  currency?: Contribution["currency"];
  sourcePath?: string;
  origin?: Contribution["origin"];
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
  const emitted = readEmittedMap(roots);
  const prevHash = emitted[input.denTopicId] ?? null;
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
    sourceCreated: input.sourceCreated,
    sourceUpdated: input.sourceUpdated,
    dateBasis: input.dateBasis,
    dateConfidence: input.dateConfidence,
    currency: input.currency,
    sourcePath: input.sourcePath,
    origin: input.origin,
  };

  const file = join(dir, `${input.denTopicId}-${hash.slice(7, 17)}.md`);
  atomicWrite(file, render(contribution));

  // Record what we emitted so a later unchanged re-promote is a true no-op
  // (no inbox churn for the sweep to hash-skip). Best-effort: the inbox file is
  // the source of truth; the map is just the dedup accelerator.
  try {
    mkdirSync(roots.denLocal, { recursive: true });
    emitted[input.denTopicId] = hash;
    atomicWrite(emittedMapPath(roots), JSON.stringify(emitted, null, 2) + "\n");
  } catch {
    /* dedup map is an optimization — never fail an emit over it */
  }

  return contribution;
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
    c.sourceCreated ? `source_created: ${c.sourceCreated}` : null,
    c.sourceUpdated ? `source_updated: ${c.sourceUpdated}` : null,
    c.dateBasis ? `date_basis: ${c.dateBasis}` : null,
    c.dateConfidence ? `date_confidence: ${c.dateConfidence}` : null,
    c.currency ? `currency: ${c.currency}` : null,
    c.sourcePath ? `source_path: ${c.sourcePath}` : null,
    c.origin ? `origin: ${c.origin}` : null,
    `submitted: ${c.submitted}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${fm}\n\n${c.summary}\n\n${c.body}\n`;
}
