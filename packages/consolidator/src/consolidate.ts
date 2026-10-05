/**
 * Wolf consolidator — the core pipeline.
 *
 * Takes a session's OM memory and folds it into the wolf's den.
 * Optionally auto-submits claims to the Librarian.
 *
 * Flow:
 *   1. Read session topics (OM output)
 *   2. Read existing den topics
 *   3. LLM: consolidate (merge/create/skip for each session topic)
 *   4. Write updated den topics
 *   5. LLM: check if anything is claim-worthy
 *   6. Write claims to Librarian inbox
 *   7. Update den journey
 *   8. Regenerate den index
 *   9. Mark session as consolidated
 */
import type { Engine, ClaimWorthiness } from "@wolfpack/engine";
import { ClaimWorthinessSchema, renderClaim, atomicWrite } from "@wolfpack/engine";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { readSessionMemory, type SessionMemory } from "./session-reader.js";
import {
  readDenTopics,
  readDenJourney,
  writeDenTopic,
  writeDenJourney,
  markSessionConsolidated,
  getConsolidatedSessions,
  ensureDenDirs,
  type DenConfig,
} from "./den.js";
import {
  CONSOLIDATE_SYSTEM,
  CLAIM_CHECK_SYSTEM,
  JOURNEY_SYSTEM,
  buildConsolidatePrompt,
  buildClaimCheckPrompt,
} from "./prompts.js";
import { ConsolidationResultSchema, type ConsolidationResult } from "./schemas.js";
import { renderDenIndex } from "./den-index.js";

export interface ConsolidateOptions {
  /** The engine instance (with provider + model config) */
  engine: Engine;
  /** Wolf den configuration */
  den: DenConfig;
  /** Path to .memory/ root (project-level) */
  memoryRoot: string;
  /** Session ID to consolidate */
  sessionId: string;
  /** Path to Librarian inbox root (e.g. ~/wolves/librarian/inbox/) */
  librarianInbox?: string;
  /** Domain for auto-claims (e.g. "snapjack", "wolfpack") */
  defaultDomain?: string;
  /** Skip claim checking */
  skipClaims?: boolean;
}

export interface ConsolidateResult {
  sessionId: string;
  topicsProcessed: number;
  topicsMerged: number;
  topicsCreated: number;
  topicsSkipped: number;
  claimsSubmitted: number;
}

/**
 * Run the wolf consolidation pipeline for a single session.
 */
export async function consolidateSession(
  options: ConsolidateOptions
): Promise<ConsolidateResult> {
  const {
    engine,
    den,
    memoryRoot,
    sessionId,
    librarianInbox,
    defaultDomain = "wolfpack",
    skipClaims = false,
  } = options;

  // Check if already consolidated
  const consolidated = getConsolidatedSessions(den.denRoot);
  if (consolidated.some((s) => s.sessionId === sessionId)) {
    return {
      sessionId,
      topicsProcessed: 0,
      topicsMerged: 0,
      topicsCreated: 0,
      topicsSkipped: 0,
      claimsSubmitted: 0,
    };
  }

  ensureDenDirs(den.denRoot);

  // Step 1: Read session memory
  const session = readSessionMemory(memoryRoot, sessionId);
  if (session.topics.length === 0) {
    markSessionConsolidated(den.denRoot, sessionId, 0);
    return {
      sessionId,
      topicsProcessed: 0,
      topicsMerged: 0,
      topicsCreated: 0,
      topicsSkipped: 0,
      claimsSubmitted: 0,
    };
  }

  // Step 2: Read existing den topics
  const denTopics = readDenTopics(den.denRoot);

  // Step 3: LLM — consolidate
  const consolidation = await engine.call(
    "consolidate",
    ConsolidationResultSchema,
    {
      system: CONSOLIDATE_SYSTEM,
      prompt: buildConsolidatePrompt(session.topics, denTopics),
    }
  );

  // Step 4: Write results to den
  let merged = 0;
  let created = 0;
  let skipped = 0;
  const updatedTopics: Array<{ id: string; title: string; body: string }> = [];

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  for (const action of consolidation.actions) {
    if (action.action === "skip" || !action.result) {
      skipped++;
      continue;
    }

    const topic = {
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      updated: now,
      body: action.result.body,
    };

    writeDenTopic(den.denRoot, topic);
    updatedTopics.push(topic);

    if (action.action === "merge") merged++;
    else created++;
  }

  // Step 5: Auto-claim check
  let claimsSubmitted = 0;

  if (!skipClaims && librarianInbox && updatedTopics.length > 0) {
    for (const topic of updatedTopics) {
      const worthiness = await engine.call(
        "claimCheck",
        ClaimWorthinessSchema,
        {
          system: CLAIM_CHECK_SYSTEM,
          prompt: buildClaimCheckPrompt(
            topic.title,
            topic.body,
            den.wolfName,
            defaultDomain
          ),
        }
      );

      if (worthiness.worthy && worthiness.title && worthiness.claim) {
        submitClaim(
          librarianInbox,
          den.wolfName,
          worthiness,
          defaultDomain
        );
        claimsSubmitted++;
      }
    }
  }

  // Step 6: Update journey
  if (session.journey) {
    const currentJourney = readDenJourney(den.denRoot);
    const updatedJourney = await updateJourney(
      engine,
      currentJourney,
      session.journey
    );
    writeDenJourney(den.denRoot, updatedJourney);
  }

  // Step 7: Regenerate den index
  renderDenIndex(den.denRoot);

  // Step 8: Mark consolidated
  markSessionConsolidated(den.denRoot, sessionId, session.topics.length);

  return {
    sessionId,
    topicsProcessed: session.topics.length,
    topicsMerged: merged,
    topicsCreated: created,
    topicsSkipped: skipped,
    claimsSubmitted,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function submitClaim(
  inboxRoot: string,
  wolfName: string,
  worthiness: ClaimWorthiness,
  domain: string
): void {
  const wolfInbox = join(inboxRoot, wolfName);
  mkdirSync(wolfInbox, { recursive: true });

  const slug = (worthiness.title ?? "claim")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const date = new Date().toISOString().split("T")[0];
  const filename = `${date}-${slug}.md`;

  const claim = renderClaim({
    from: wolfName,
    domain: worthiness.domain ?? domain,
    origin: "auto",
    submitted: new Date().toISOString().replace("T", " ").slice(0, 16),
    title: worthiness.title!,
    claim: worthiness.claim!,
    evidence: worthiness.evidence ?? "Auto-extracted from wolf session memory",
    sources: [],
  });

  atomicWrite(join(wolfInbox, filename), claim);
}

async function updateJourney(
  engine: Engine,
  currentJourney: string | null,
  sessionJourney: string
): Promise<string> {
  // For now, append the session journey to the den journey.
  // Use the LLM to merge and compress if we want to get fancy later.
  const current = currentJourney ?? "";
  const date = new Date().toISOString().split("T")[0];

  // Simple append for v1 — the LLM journey update can be added when needed
  const segment = `\n## ${date}\n${sessionJourney}\n`;
  return (current + segment).trim();
}
