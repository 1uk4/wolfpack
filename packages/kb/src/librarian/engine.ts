/**
 * The engine the librarian sweeps and reorganizes with. One factory for the
 * harness timer and the kb CLI, so both talk to the model the same way.
 */
import { createEngine, engineSteps, type Engine, type ModelTable } from "@wolfpack/engine";

/**
 * Build the librarian engine from the resolved model table. `apiKey` is only
 * needed when the wolf's transport is api.
 */
export function createLibrarianEngine(table: ModelTable, apiKey = process.env.ANTHROPIC_API_KEY): Engine {
  const provider = table.tiers.smart.provider;
  if (provider === "anthropic" && !apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required (this wolf's transport is api)");
  }
  const steps = engineSteps(table);
  // Bound a single hanging call (anthropic path only; the bridge has no API
  // timeout and ignores this). Default 10m is generous enough for a large
  // 16k-token produce but still caps a wedged request. Tunable per run.
  const requestTimeoutMs = Number(process.env.WOLFPACK_REQUEST_TIMEOUT_MS) || 600_000;
  return createEngine({
    provider,
    ...(provider === "anthropic" ? { apiKey } : {}),
    defaultModel: table.tiers.smart.model,
    requestTimeoutMs,
    steps: {
      ...steps,
      // Entries (esp. merges) produce large JSON; the 4096 default truncates it
      // and breaks JSON extraction (same lesson as the memory consolidator).
      produce: { ...steps.produce, maxTokens: 16000 },
    },
  });
}
