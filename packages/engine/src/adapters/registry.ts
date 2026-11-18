import type { KnowledgeAdapter } from "../adapter.js";
import type { EngineConfig } from "../config.js";

export type AdapterFactory = (config: EngineConfig) => KnowledgeAdapter;

// Kept on globalThis: wolfd and the memory extension are separate bundles that each carry their own copy of this
// module, and an adapter a plug-in registers in wolfd must resolve in the extension's engine steps too.
const KEY = Symbol.for("wolfpack.engine.adapterRegistry");
const registry = ((globalThis as any)[KEY] ??= new Map<string, AdapterFactory>()) as Map<string, AdapterFactory>;

/** Register an engine adapter under a provider id. A second registration of the same id is an error. */
export function registerAdapter(id: string, factory: AdapterFactory): void {
  if (registry.has(id)) throw new Error(`engine adapter "${id}" is already registered`);
  registry.set(id, factory);
}
/** Built-ins register in every bundle that carries this module; the first one wins and later ones are no-ops. */
export function registerBuiltInAdapter(id: string, factory: AdapterFactory): void {
  if (!registry.has(id)) registry.set(id, factory);
}
export const adapterFactory = (id: string): AdapterFactory | undefined => registry.get(id);
export const adapterIds = (): string[] => [...registry.keys()];
export const hasAdapter = (id: string): boolean => registry.has(id);
