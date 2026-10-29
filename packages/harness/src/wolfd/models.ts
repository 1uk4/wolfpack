/**
 * Engine model registry built from the providers a wolf's tiers name (provider factory map, providers/index.ts).
 * One registry, only the providers in use: a tier config without the bridge never loads it, and a subscription-only
 * config never registers the metered anthropic provider, so a failed turn cannot fall over onto the metered key.
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { tierPiProvider, TIERS, type ModelTable } from "@wolfpack/engine";
import { PROVIDER_FACTORIES, guardProviderStreams, type ProviderContext, type ProviderFactory } from "../providers/index.js";

export { guardProviderStreams };

export interface WolfModels {
  /** Undefined = the engine's default registry (anthropic only). */
  models?: Models;
  /** Release everything the providers hold. Call on wolf shutdown. */
  dispose(): void;
  /** A conversation (its provider session id) ended: providers that hold per-conversation state free it. */
  forget(sessionId: string): void;
}

export interface BuildWolfModelsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces/extends the factory map. */
  factories?: Record<string, ProviderFactory>;
  /** Per-provider test seams, handed to the factories. */
  seams?: ProviderContext["seams"];
}

/** Distinct pi providers the table's tiers use, in tier order. Legacy tables map through their transport. */
export function providersInUse(table: Pick<ModelTable, "transport" | "tiers">): string[] {
  const ids: string[] = [];
  for (const t of TIERS) {
    const entry = table.tiers[t];
    if (!entry) continue;
    const id = tierPiProvider(table, entry);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function buildModelRegistry(providers: readonly string[], opts: BuildWolfModelsOptions): Required<Pick<WolfModels, "dispose" | "forget">> & { models: Models } {
  const factories = opts.factories ?? PROVIDER_FACTORIES;
  const ctx: ProviderContext = { cwd: opts.cwd, env: opts.env ?? process.env, ...(opts.seams ? { seams: opts.seams } : {}) };
  const models = createModels();
  const handles: Array<{ forget?(id: string): void; dispose?(): void }> = [];
  try {
    for (const id of providers) {
      const factory = factories[id];
      if (!factory) throw new Error(`no model provider "${id}" (known: ${Object.keys(factories).join(", ")}) — add a factory in providers/index.ts`);
      const handle = factory(ctx);
      handles.push(handle);
      models.setProvider(handle.provider);
    }
  } catch (err) {
    for (const h of handles) try { h.dispose?.(); } catch { /* best effort */ }
    throw err;
  }
  return {
    models,
    dispose: () => { for (const h of handles) try { h.dispose?.(); } catch { /* best effort */ } },
    forget: (sessionId) => { for (const h of handles) try { h.forget?.(sessionId); } catch { /* best effort */ } },
  };
}

/** wolfd's registry: every tier's provider. Only anthropic → no custom registry (the engine's default). */
export function buildWolfModels(table: Pick<ModelTable, "transport" | "tiers">, opts: BuildWolfModelsOptions): WolfModels {
  const ids = providersInUse(table);
  if (ids.every((id) => id === "anthropic")) return { dispose: () => {}, forget: () => {} };
  return buildModelRegistry(ids, opts);
}
