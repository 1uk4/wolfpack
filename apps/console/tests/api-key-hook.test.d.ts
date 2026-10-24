/**
 * The getApiKey-hook fix (owner, 2026-09-26): both Agent constructions
 * (baseAgentOptions in teacher-agent.ts, runSubagent's loop in
 * subagents/pi-run.ts) used to pass `getApiKey: () => openRouterApiKey()` —
 * and pi-agent-core resolves
 * `(config.getApiKey ? await config.getApiKey(provider) : undefined) || config.apiKey`
 * (agent-loop.js:191), so a provided hook OVERRIDES pi-ai's native
 * per-provider env resolution. The hook ignored its provider arg, so every
 * non-OpenRouter provider was sent the OpenRouter key and 401'd (owner repro:
 * openai:gpt-5.6-luna, anthropic:claude-haiku-4-5 direct).
 *
 * The fix is DELETION: with no hook, pi-ai resolves keys natively from the
 * environment per request — the architecture's stated intent (models.ts:
 * "the keys seam reflects file-saved keys into env"). This file pins that
 * the deletion holds: the built agents must expose NO getApiKey hook, so
 * native resolution runs for every provider.
 *
 * runSubagent's Agent is internal to its promise (no exposed seam); its
 * hook was deleted in the same commit and its behavior is covered by the
 * sub-agent suite's faux engines.
 */
export {};
//# sourceMappingURL=api-key-hook.test.d.ts.map