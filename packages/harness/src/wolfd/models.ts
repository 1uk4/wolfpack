/**
 * Engine model registry for a wolf's resolved transport. api: undefined (the engine's default anthropic provider,
 * which reads ANTHROPIC_API_KEY). subscription: a registry holding only the pi-claude-bridge provider — no anthropic
 * provider is registered, so a failed subscription turn can never fall over onto the metered key.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { createClaudeBridgeProvider, PROVIDER_ID, type ClaudeBridgeProvider, type ClaudeBridgeProviderOptions } from "pi-claude-bridge/core";
import type { ResolvedWolfModel } from "@wolfpack/engine";
import type { WolfEngineOptions } from "../engine/index.js";

export interface WolfModels {
  models?: WolfEngineOptions["models"];
  /** Kills any parked SDK queries. Call on wolf shutdown. */
  shutdown(): void;
}

export interface BuildWolfModelsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the real bridge provider factory. */
  createProvider?: (opts: ClaudeBridgeProviderOptions) => ClaudeBridgeProvider;
}

export function buildWolfModels(model: Pick<ResolvedWolfModel, "transport" | "provider">, opts: BuildWolfModelsOptions): WolfModels {
  if (model.transport !== "subscription") return { shutdown: () => {} };
  if (model.provider !== PROVIDER_ID) {
    throw new Error(`subscription transport resolved provider "${model.provider}", expected "${PROVIDER_ID}"`);
  }
  // Env hygiene (stripping ANTHROPIC_API_KEY from the claude child) is done inside the bridge core.
  const provider = (opts.createProvider ?? createClaudeBridgeProvider)({ cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
  const models = createModels();
  models.setProvider(provider);
  return { models, shutdown: () => provider.shutdown() };
}
