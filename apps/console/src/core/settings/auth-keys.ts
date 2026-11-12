/**
 * The model-provider key table. PURE, browser-safe: no fs, no env. Keys are identified by their environment-variable name, the same
 * name pi-ai reads (OPENROUTER_API_KEY, ...). The console no longer stores keys itself (work-wolfpack-u6GH2kk): the Pack key file holds
 * them (src/server/settings/keys.ts); this table only says which env var each provider takes.
 */

/** One model-provider key row for the settings page's dropdown: which
 *  pi-ai provider, the env var its key rides in, and the human label
 *  (pi's own Provider.name). */
export interface AuthProviderInfo {
	id: string;
	envVar: string;
	label: string;
}

/**
 * THE MODEL-PROVIDER KEY TABLE (provider-keys interlude, 2026-09-19):
 * every pi-ai provider that takes a PLAIN api-key env var — derived from
 * pi-ai's own provider→env-var table at generation time, so it can never
 * drift from what pi actually reads: tests/core/settings/auth-provider-keys.test.ts
 * re-derives the truth from pi-ai (builtinProviders + findEnvKeys via a
 * truthy-for-every-var proxy env) and asserts EXACT equality with this
 * table — a pi-ai upgrade that adds/renames a provider key fails the gate
 * loudly instead of drifting silently.
 *
 * EXCLUDED by owner spec — providers whose auth is not a plain key this
 * wave: github-copilot (OAuth), amazon-bedrock (AWS creds), google-vertex
 * (ADC), azure (needs a base URL), the cloudflare
 * account-scoped pair. Anthropic keeps ANTHROPIC_API_KEY only — its
 * AUTH_TOKEN/OAUTH_TOKEN alternates stay env-only. openai-codex exposes
 * no env-key (naturally absent). Providers sharing one env var (moonshotai
 * / moonshotai-cn, opencode / opencode-go, the qwen-token-plan pair,
 * xiaomi variants) each keep their own row — the UI groups as it wishes.
 */
export const AUTH_PROVIDER_KEYS: readonly AuthProviderInfo[] = [
	{ id: "ant-ling", envVar: "ANT_LING_API_KEY", label: "Ant Ling" },
	{ id: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
	{ id: "baseten", envVar: "BASETEN_API_KEY", label: "Baseten" },
	{ id: "cerebras", envVar: "CEREBRAS_API_KEY", label: "Cerebras" },
	{ id: "deepseek", envVar: "DEEPSEEK_API_KEY", label: "DeepSeek" },
	{ id: "fireworks", envVar: "FIREWORKS_API_KEY", label: "Fireworks" },
	{ id: "google", envVar: "GEMINI_API_KEY", label: "Google" },
	{ id: "groq", envVar: "GROQ_API_KEY", label: "Groq" },
	{ id: "huggingface", envVar: "HF_TOKEN", label: "Hugging Face" },
	{ id: "kimi-coding", envVar: "KIMI_API_KEY", label: "Kimi For Coding" },
	{ id: "meta", envVar: "META_API_KEY", label: "Meta" },
	{ id: "minimax", envVar: "MINIMAX_API_KEY", label: "MiniMax" },
	{ id: "minimax-cn", envVar: "MINIMAX_CN_API_KEY", label: "MiniMax CN" },
	{ id: "mistral", envVar: "MISTRAL_API_KEY", label: "Mistral" },
	{ id: "moonshotai", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI" },
	{ id: "moonshotai-cn", envVar: "MOONSHOT_API_KEY", label: "Moonshot AI CN" },
	{ id: "nvidia", envVar: "NVIDIA_API_KEY", label: "NVIDIA" },
	{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
	{ id: "opencode", envVar: "OPENCODE_API_KEY", label: "OpenCode Zen" },
	{ id: "opencode-go", envVar: "OPENCODE_API_KEY", label: "OpenCode Go" },
	{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" },
	{ id: "qwen-token-plan", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan" },
	{ id: "qwen-token-plan-cn", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY", label: "Qwen Token Plan CN" },
	{ id: "qwen-token-plan-individual", envVar: "QWEN_TOKEN_PLAN_API_KEY", label: "Qwen Token Plan Individual" },
	{ id: "radius", envVar: "RADIUS_API_KEY", label: "Radius" },
	{ id: "together", envVar: "TOGETHER_API_KEY", label: "Together" },
	{ id: "typesafe", envVar: "TYPESAFE_API_KEY", label: "TypeSafe" },
	{ id: "vercel-ai-gateway", envVar: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway" },
	{ id: "xai", envVar: "XAI_API_KEY", label: "xAI" },
	{ id: "xiaomi", envVar: "XIAOMI_API_KEY", label: "Xiaomi" },
	{ id: "xiaomi-token-plan-ams", envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", label: "Xiaomi Token Plan AMS" },
	{ id: "xiaomi-token-plan-cn", envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY", label: "Xiaomi Token Plan CN" },
	{ id: "xiaomi-token-plan-sgp", envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", label: "Xiaomi Token Plan SGP" },
	{ id: "zai", envVar: "ZAI_API_KEY", label: "Z.AI" },
	{ id: "zai-coding-cn", envVar: "ZAI_CODING_CN_API_KEY", label: "Z.AI Coding CN" },
] as const;

/** Every distinct env var a model-provider key rides in (the write side's
 *  writability check — see isProviderEnvVar below; also drives which
 *  PRESENT provider vars surface as status rows). */
export const AUTH_PROVIDER_ENV_VARS: ReadonlySet<string> = new Set(AUTH_PROVIDER_KEYS.map((p) => p.envVar));

/** Is this env-var name the key of SOME pi-ai model provider? */
export function isProviderEnvVar(envVar: string): boolean {
	return AUTH_PROVIDER_ENV_VARS.has(envVar);
}
