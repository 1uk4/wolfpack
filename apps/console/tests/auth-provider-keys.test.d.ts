/**
 * THE NO-DRIFT PIN (provider-keys interlude, 2026-09-19): core/auth-keys.ts
 * AUTH_PROVIDER_KEYS claims to be exactly pi-ai's provider→env-var table
 * (minus the owner-spec exclusions). This test re-derives the TRUTH from
 * pi-ai itself and asserts exact equality — so a pi-ai upgrade that adds,
 * renames, or re-labels a provider key FAILS the gate loudly instead of
 * the table drifting silently from what pi actually reads.
 *
 * Derivation (same mechanism that generated the table): pi-ai's exports
 * map doesn't expose env-api-keys.js as a subpath, so this test
 * deep-imports it by RELATIVE path — tests may; runtime code never does.
 * findEnvKeys with a Proxy env that resolves every var name truthy returns
 * ALL the env vars a provider reads as API keys.
 *
 * Owner-spec exclusions (asserted ABSENT): github-copilot (OAuth),
 * amazon-bedrock (AWS creds), google-vertex (ADC), azure
 * (needs base URL), the cloudflare account-scoped pair; anthropic keeps
 * ANTHROPIC_API_KEY only (AUTH_TOKEN/OAUTH_TOKEN stay env-only).
 */
export {};
//# sourceMappingURL=auth-provider-keys.test.d.ts.map