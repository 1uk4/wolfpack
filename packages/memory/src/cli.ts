#!/usr/bin/env node
/**
 * Wolf consolidator CLI — consolidate OM session memory into a wolf's den.
 *
 * Usage:
 *   wolfpack-consolidate --wolf 1uk4 --den ~/wolves/dens/1uk4 --memory .memory
 *   wolfpack-consolidate --wolf 1uk4 --den ~/wolves/dens/1uk4 --memory .memory --session <id>
 *   wolfpack-consolidate --wolf 1uk4 --den ~/wolves/dens/1uk4 --memory .memory --all
 *
 * Environment:
 *   ANTHROPIC_API_KEY     — required
 *   WOLFPACK_MODEL        — default model (default: claude-sonnet-4-6)
 *   WOLFPACK_FAST_MODEL   — model for cheap steps (default: claude-haiku-4-5-20251001)
 *   WOLFPACK_LIBRARIAN    — path to librarian inbox (enables auto-claims)
 *   WOLFPACK_DOMAIN       — default domain for claims (default: wolfpack)
 */
import { createEngine } from "@wolfpack/engine";
import type { KbRoots } from "@wolfpack/kb/shared";
import { emitDelta } from "@wolfpack/kb/client";
import { consolidateSession } from "./consolidate.js";
import { listSessionIds } from "./session/memory.js";
import { getConsolidatedSessions, readDenTopics } from "./den.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse args
  const flags: Record<string, string> = {};
  const booleanFlags = new Set(["--all", "--dry-run", "--emit-den"]);
  for (let i = 0; i < args.length; i++) {
    if (booleanFlags.has(args[i])) {
      flags[args[i].slice(2)] = "true";
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  const wolfName = flags.wolf;
  const denRoot = flags.den;
  const memoryRoot = flags.memory ?? ".memory";

  if (!wolfName || !denRoot) {
    console.error("Usage: wolfpack-consolidate --wolf <name> --den <path> [--memory <path>] [--session <id> | --all]");
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const defaultModel = process.env.WOLFPACK_MODEL ?? "claude-sonnet-4-6";
  const fastModel = process.env.WOLFPACK_FAST_MODEL ?? "claude-haiku-4-5-20251001";

  const engine = createEngine({
    provider: "anthropic",
    apiKey,
    defaultModel,
    steps: {
      consolidate: { model: defaultModel },
    },
  });

  const resolvedDen = resolve(denRoot);
  const resolvedMemory = resolve(memoryRoot);
  // KB roots: emitting deltas requires at least the ops root (librarian-ops).
  const kbOps = process.env.WOLFPACK_KB_OPS;
  const kbBase = process.env.KB_BASE;
  const kbRoots: KbRoots | undefined = kbOps
    ? {
        kbBase: kbBase ? resolve(kbBase) : "",
        opsRoot: resolve(kbOps),
        denLocal: resolve(resolvedDen, "kb"),
      }
    : undefined;
  const defaultDomain = process.env.WOLFPACK_DOMAIN ?? "wolfpack";

  // Backfill: emit a contribution delta for EVERY existing den topic (not just
  // ones changed this session). Seeds the KB with a wolf's accumulated memory.
  // Deterministic, no LLM. Idempotent (hash-named files overwrite).
  if (flags["emit-den"]) {
    if (!kbRoots) {
      console.error("--emit-den requires WOLFPACK_KB_OPS (librarian-ops root)");
      process.exit(1);
    }
    const topics = readDenTopics(resolvedDen);
    let emitted = 0;
    for (const t of topics) {
      const d = emitDelta({
        roots: kbRoots,
        wolf: wolfName,
        denTopicId: t.id,
        change: "create",
        domainHint: defaultDomain,
        summary: t.summary,
        body: t.body,
      });
      if (d) {
        emitted++;
        console.log(`  emitted: ${t.id}`);
      }
    }
    console.log(
      `emit-den: ${emitted}/${topics.length} deltas \u2192 ${kbRoots.opsRoot}/inbox/${wolfName}`
    );
    return;
  }

  // Determine which sessions to consolidate
  let sessionIds: string[];

  if (flags.session) {
    sessionIds = [flags.session];
  } else if (flags.all) {
    const allSessions = listSessionIds(resolvedMemory);
    const done = new Set(
      getConsolidatedSessions(resolvedDen).map((s) => s.sessionId)
    );
    sessionIds = allSessions.filter((s) => !done.has(s));
  } else {
    // Default: show available sessions
    const allSessions = listSessionIds(resolvedMemory);
    const done = new Set(
      getConsolidatedSessions(resolvedDen).map((s) => s.sessionId)
    );
    const pending = allSessions.filter((s) => !done.has(s));

    console.log(`Wolf: ${wolfName}`);
    console.log(`Den: ${resolvedDen}`);
    console.log(`Memory: ${resolvedMemory}`);
    console.log(`Sessions: ${allSessions.length} total, ${pending.length} pending`);

    if (pending.length > 0) {
      console.log("\nPending sessions:");
      for (const s of pending) {
        console.log(`  ${s}`);
      }
      console.log("\nRun with --all to consolidate all, or --session <id> for one.");
    } else {
      console.log("\nAll sessions consolidated.");
    }
    return;
  }

  if (sessionIds.length === 0) {
    console.log("No sessions to consolidate.");
    return;
  }

  console.log(`Consolidating ${sessionIds.length} session(s) for ${wolfName}...`);

  let totalMerged = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalClaims = 0;

  for (const sessionId of sessionIds) {
    console.log(`\n--- Session: ${sessionId} ---`);

    const result = await consolidateSession({
      engine,
      den: { denRoot: resolvedDen, wolfName },
      memoryRoot: resolvedMemory,
      sessionId,
      kbRoots,
      defaultDomain,
      skipClaims: !kbRoots,
    });

    console.log(
      `  Topics: ${result.topicsProcessed} processed ` +
        `(${result.topicsMerged} merged, ${result.topicsCreated} created, ${result.topicsSkipped} skipped)`
    );
    if (result.claimsSubmitted > 0) {
      console.log(`  Claims: ${result.claimsSubmitted} submitted`);
    }

    totalMerged += result.topicsMerged;
    totalCreated += result.topicsCreated;
    totalSkipped += result.topicsSkipped;
    totalClaims += result.claimsSubmitted;
  }

  // Usage summary
  const usage = engine.usage.summarize();
  console.log("\n--- Summary ---");
  console.log(`Sessions: ${sessionIds.length}`);
  console.log(`Topics: ${totalMerged} merged, ${totalCreated} created, ${totalSkipped} skipped`);
  console.log(`Claims: ${totalClaims} submitted`);
  console.log(`Tokens: ${usage.totalInputTokens.toLocaleString()} in, ${usage.totalOutputTokens.toLocaleString()} out`);

  if (Object.keys(usage.byModel).length > 1) {
    console.log("\nBy model:");
    for (const [model, stats] of Object.entries(usage.byModel)) {
      console.log(`  ${model}: ${stats.calls} calls, ${(stats.input + stats.output).toLocaleString()} tokens`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
