/**
 * Engine model registry built from the providers a wolf's tiers name (provider factory map, providers/index.ts).
 * One registry, only the providers in use: a tier config without the bridge never loads it, and a subscription-only
 * config never registers the metered anthropic provider as servable, so a failed turn cannot fall over onto the
 * metered key. Stored refs to other providers resolve through lookup-only stubs.
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { tierPiProvider, TIERS, type ModelTable } from "@wolfpack/engine";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LOOKUP_MODELS, PROVIDER_FACTORIES, guardProviderStreams, lookupOnlyProvider, type ProviderContext, type ProviderFactory } from "../providers/index.js";

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
  /** Provider ids stored in the den (see storedProviderIds). Those not in use are registered lookup-only. */
  storedProviders?: readonly string[];
  /** Test seam: replaces LOOKUP_MODELS. */
  lookups?: typeof LOOKUP_MODELS;
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
  let disposed = false;
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
  const lookups = opts.lookups ?? LOOKUP_MODELS;
  for (const id of opts.storedProviders ?? []) {
    const list = lookups[id];
    if (providers.includes(id) || !list || models.getProvider(id)) continue;
    models.setProvider(lookupOnlyProvider(id, () => list(ctx)));
  }
  return {
    models,
    dispose: () => { if (disposed) return; disposed = true; for (const h of handles) try { h.dispose?.(); } catch { /* best effort */ } },
    forget: (sessionId) => { for (const h of handles) try { h.forget?.(sessionId); } catch { /* best effort */ } },
  };
}

/**
 * Distinct provider ids stored in a den (conversation records and document revisions: pi.agent / pi.provider model
 * refs). The Harness resolves each through `models.getModel`, so each must be registered, in use or lookup-only.
 * Read-only; a missing or unreadable store yields none.
 */
export function storedProviderIds(storagePath: string): string[] {
  if (!existsSync(storagePath)) return [];
  const ids = new Set<string>();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(storagePath, { readOnly: true });
    for (const sql of ["select record as v from conversations", "select content as v from document_revisions"]) {
      for (const row of db.prepare(sql).all() as Array<{ v: string }>) {
        for (const m of String(row.v).matchAll(/"provider"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!);
      }
    }
  } catch { /* unreadable store: nothing to register */ } finally { try { db?.close(); } catch { /* ignore */ } }
  return [...ids];
}

/**
 * wolfd's registry: one provider per distinct tier provider. All-anthropic tiers (and a den with no other stored
 * providers) → no custom registry (the engine's default). A mixed config that registers anthropic next to the
 * bridge is an intentional opt-in (e.g. fast on the metered key); a bridge-only config never registers anthropic
 * as a servable provider (stored refs resolve through a lookup-only stub that errors on use).
 */
export function buildWolfModels(table: Pick<ModelTable, "transport" | "tiers">, opts: BuildWolfModelsOptions): WolfModels {
  const ids = providersInUse(table);
  if (ids.every((id) => id === "anthropic") && !(opts.storedProviders ?? []).some((id) => id !== "anthropic")) return { dispose: () => {}, forget: () => {} };
  return buildModelRegistry(ids, opts);
}
