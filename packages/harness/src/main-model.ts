/**
 * Provider choice for the pi-durable VPS harness main agent. The main tier names its provider (`piProvider`, or the
 * legacy `transport` default); the registry is built from that provider's factory (providers/index.ts). There is no
 * silent fallback: a provider that cannot start fails startup with a clear error rather than spilling a Max
 * subscription wolf onto the metered API key. Stored model refs are not aliased between providers — the root is
 * re-configured to the tier's model on every start.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import { loadQuery, tierPiProvider, type ModelTable } from "@wolfpack/engine";
import { buildModelRegistry, type BuildWolfModelsOptions } from "./wolfd/models.js";
import { SDK_PROVIDER_SEAMS } from "./providers/index.js";

export interface MainModelChoice {
  /** Registry for Harness.open. */
  models: Models;
  model: { provider: string; modelId: string };
  /** One startup line: "Main agent via <provider>". */
  line: string;
  /** The conversation (provider session id) ended; providers holding per-conversation state free it. */
  forget(sessionId: string): void;
  dispose(): void;
}

export interface SelectMainModelOptions {
  table: Pick<ModelTable, "transport" | "tiers">;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Provider ids stored in the den (storedProviderIds); those the main tier does not use resolve lookup-only. */
  storedProviders?: readonly string[];
  /** Test seams. */
  factories?: BuildWolfModelsOptions["factories"];
  seams?: BuildWolfModelsOptions["seams"];
  lookups?: BuildWolfModelsOptions["lookups"];
  /** Hands the Agent SDK `query` to providers that need it (they receive it as seams[provider].queryFn). */
  loadSdkQuery?: () => Promise<unknown>;
}

export async function selectMainModel(opts: SelectMainModelOptions): Promise<MainModelChoice> {
  const env = opts.env ?? process.env;
  const main = opts.table.tiers.main;
  const provider = tierPiProvider(opts.table, main);
  const seams: Record<string, unknown> = { ...(opts.seams ?? {}) };
  // The Agent SDK cannot be bundled: providers that run on it get the host's `query`.
  const sdkSeams = SDK_PROVIDER_SEAMS[provider];
  if (sdkSeams) seams[provider] = { ...sdkSeams(await (opts.loadSdkQuery ?? loadQuery)(), env), ...((seams[provider] as object | undefined) ?? {}) };
  let reg;
  try {
    reg = buildModelRegistry([provider], { cwd: opts.cwd, env, seams, ...(opts.storedProviders ? { storedProviders: opts.storedProviders } : {}), ...(opts.lookups ? { lookups: opts.lookups } : {}), ...(opts.factories ? { factories: opts.factories } : {}) });
  } catch (err) {
    throw new Error(`main agent provider "${provider}" failed to start: ${err instanceof Error ? err.message : err}`);
  }
  // The model must exist in the provider's table, or every turn (and root.configure) would fail with "model not found".
  if (!reg.models.getModel(provider, main.model)) {
    reg.dispose();
    throw new Error(`model "${main.model}" is not in the ${provider} model table`);
  }
  return {
    models: reg.models,
    model: { provider, modelId: main.model },
    line: `Main agent via ${provider}`,
    forget: reg.forget,
    dispose: reg.dispose,
  };
}

type RootLike = { configure(...args: any[]): Promise<unknown> };

/** Open the root conversation on the chosen provider and (re)apply the model. */
export async function startRoot<R extends RootLike>(
  choice: MainModelChoice,
  open: (agent: { model: { provider: string; modelId: string } }) => Promise<R>,
  thinking: string | undefined,
  ctx: unknown,
): Promise<R> {
  const root = await open({ model: choice.model });
  // open() applies the model only when it creates the conversation; an existing root keeps the one it was created
  // with, so re-apply on every start: the shipped table (models.json) decides the model, not history.
  try {
    await root.configure({ model: choice.model, thinkingLevel: thinking ?? null }, ctx);
  } catch (err) {
    console.error(`[harness] Could not re-apply the main model to the root: ${err instanceof Error ? err.message : err}`);
  }
  return root;
}
