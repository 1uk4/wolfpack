/**
 * Provider choice for the pi-durable VPS harness main agent. subscription transport + a Max OAuth token → the
 * pi-claude-bridge provider (same factory wolfd uses); otherwise, or if the bridge cannot start, pi-ai's anthropic
 * provider on the API key. A bridge-selected registry holds ONLY the bridge, so a failed turn never spills onto the key.
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { loadQuery, type ModelTable } from "@wolfpack/engine";
import { BRIDGE_PROVIDER_ID, createBridgeModels, type BuildWolfModelsOptions } from "./wolfd/models.js";

export interface MainModelChoice {
  via: "bridge" | "api";
  models: Models;
  model: { provider: string; modelId: string };
  /** One startup line: "Main agent via Max subscription (claude-bridge)" / "Main agent via API key (reason)". */
  line: string;
  /** Set when the bridge was wanted but failed to initialise. */
  warning?: string;
  shutdown(): void;
  release(sessionId: string): void;
}

export interface SelectMainModelOptions {
  table: Pick<ModelTable, "transport" | "tiers">;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seams. */
  createProvider?: BuildWolfModelsOptions["createProvider"];
  loadSdkQuery?: () => Promise<unknown>;
}

export async function selectMainModel(opts: SelectMainModelOptions): Promise<MainModelChoice> {
  const env = opts.env ?? process.env;
  const modelId = opts.table.tiers.main.model;
  const api = (reason: string, warning?: string): MainModelChoice => {
    const models = createModels();
    models.setProvider(anthropicProvider());
    return {
      via: "api", models, model: { provider: "anthropic", modelId },
      line: `Main agent via API key (${reason})`, ...(warning ? { warning } : {}),
      shutdown: () => {}, release: () => {},
    };
  };
  if (opts.table.transport !== "subscription") return api("transport api");
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return api("no CLAUDE_CODE_OAUTH_TOKEN");
  try {
    // The Agent SDK cannot be bundled; resolve it from the host (NODE_PATH, global install) and hand it to the bridge.
    const query = (await (opts.loadSdkQuery ?? loadQuery)()) as NonNullable<Parameters<typeof createBridgeModels>[0]["queryFn"]>;
    const b = createBridgeModels({ cwd: opts.cwd, env, queryFn: query, ...(env.WOLF_HARNESS_SMOKE ? { sweepOrphans: false } : {}), ...(opts.createProvider ? { createProvider: opts.createProvider } : {}) });
    return {
      via: "bridge", models: b.models, model: { provider: BRIDGE_PROVIDER_ID, modelId },
      line: "Main agent via Max subscription (claude-bridge)", shutdown: b.shutdown, release: b.release,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return api("bridge unavailable", `claude-bridge failed to initialise, falling back to the API key: ${msg}`);
  }
}
