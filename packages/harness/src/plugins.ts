/**
 * Provider plug-ins (work-wolfpack-66JSDus). A plug-in is a folder `<pluginsDir>/<id>/` whose package.json has a
 * `wolfpack` field (manifest, see providers/README.md). It loads only when wolf.yaml lists it under `plugins:`;
 * a folder alone never runs code. loadPlugins() runs once at startup, before the main model is chosen, and
 * registers the plug-in's model providers (registerProviderFactory) and engine adapters (registerAdapter).
 * Any failure of an enabled plug-in throws: there is no silent fallback.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { registerAdapter, type AdapterFactory } from "@wolfpack/engine";
import { packStateDir } from "@wolfpack/protocol/runtime-home";
import { hasProviderFactory, LOOKUP_MODELS, registerProviderFactory } from "./providers/index.js";
import type { ProviderContext, ProviderFactory } from "./providers/types.js";

export const PLUGIN_API_VERSION = 1;

/** What a plug-in's factories are handed: the environment narrowed to the manifest's `requiredEnv`, plus the usual context. */
export type PluginContext = Omit<ProviderContext, "env"> & { env: Record<string, string> };

/** The default export of a plug-in's entry file. */
export interface PluginModule {
  apiVersion: 1;
  createProvider?(ctx: PluginContext): ReturnType<ProviderFactory>;
  createEngineAdapter?(ctx: { env: Record<string, string>; config: Parameters<AdapterFactory>[0] }): ReturnType<AdapterFactory>;
  /** The provider's model list without starting it (stored refs to it resolve lookup-only). */
  models?(ctx: PluginContext): readonly any[];
}

interface Manifest {
  apiVersion?: unknown;
  entry?: unknown;
  requiredEnv?: unknown;
  providers?: unknown;
  engineProviders?: unknown;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function stringList(id: string, key: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`Plug-in ${id}: "${key}" in its wolfpack manifest must be an array of strings.`);
  return v as string[];
}

export function pluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WOLFPACK_PLUGINS_DIR?.trim() || join(packStateDir(env), "plugins");
}

export interface LoadPluginsOptions {
  /** wolf.yaml `plugins:`. Nothing else is read from disk. */
  enabled: readonly string[];
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<string[]> {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? pluginsDir(env);
  for (const id of opts.enabled) await loadOne(id, dir, env);
  return [...opts.enabled];
}

async function loadOne(id: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (typeof id !== "string" || !ID_RE.test(id) || id === "." || id === "..") throw new Error(`Plug-in id ${JSON.stringify(id)} is not valid; use lowercase letters, digits, ".", "_" and "-" (no path separators).`);
  const root = join(dir, id);
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`Plug-in ${id} is enabled in wolf.yaml but ${pkgFile} was not found; install it there or remove it from plugins:.`);
  let manifest: Manifest | undefined;
  try { manifest = JSON.parse(readFileSync(pkgFile, "utf8")).wolfpack; } catch (e) { throw new Error(`Plug-in ${id}: cannot read ${pkgFile} (${(e as Error).message}).`); }
  if (!manifest || typeof manifest !== "object") throw new Error(`Plug-in ${id}: ${pkgFile} has no "wolfpack" field.`);
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new Error(`Plug-in ${id} was built for plug-in API ${String(manifest.apiVersion)}; this Wolfpack needs ${PLUGIN_API_VERSION}.`);
  const required = stringList(id, "requiredEnv", manifest.requiredEnv);
  const providers = stringList(id, "providers", manifest.providers);
  const engineProviders = stringList(id, "engineProviders", manifest.engineProviders);
  if (manifest.entry !== undefined && typeof manifest.entry !== "string") throw new Error(`Plug-in ${id}: "entry" in its wolfpack manifest must be a string.`);
  const pluginEnv: Record<string, string> = {};
  for (const name of required) {
    const v = env[name];
    if (!v) throw new Error(`Plug-in ${id} needs ${name}; set it and restart.`);
    pluginEnv[name] = v;
  }
  for (const p of providers) if (hasProviderFactory(p) || Object.hasOwn(LOOKUP_MODELS, p)) throw new Error(`Plug-in ${id} declares provider "${p}", which is already registered (a built-in or another plug-in); rename it.`);

  const entryPath = resolve(root, (manifest.entry as string | undefined) ?? "./dist/index.js");
  if (!existsSync(entryPath)) throw new Error(`Plug-in ${id}: entry ${entryPath} was not found; build or reinstall the plug-in.`);
  // Confinement: the real folder and the real entry must both stay inside the plug-ins dir, and the entry inside its folder.
  const dirReal = realpathSync(dir);
  const rootReal = realpathSync(root);
  const entry = realpathSync(entryPath);
  if (!rootReal.startsWith(dirReal + sep)) throw new Error(`Plug-in ${id}: its folder must be inside the plug-ins folder.`);
  if (!entry.startsWith(rootReal + sep)) throw new Error(`Plug-in ${id}: entry must be inside its folder.`);
  let mod: PluginModule;
  try {
    const ns = await import(pathToFileURL(entry).href);
    mod = (ns.default ?? ns) as PluginModule;
  } catch (e) {
    throw new Error(`Plug-in ${id} failed to load (${(e as Error).message}).`);
  }
  if (mod?.apiVersion !== PLUGIN_API_VERSION) throw new Error(`Plug-in ${id} was built for plug-in API ${String(mod?.apiVersion)}; this Wolfpack needs ${PLUGIN_API_VERSION}.`);

  if (providers.length && !mod.createProvider) throw new Error(`Plug-in ${id} declares providers but its entry has no createProvider.`);
  if (engineProviders.length && !mod.createEngineAdapter) throw new Error(`Plug-in ${id} declares engineProviders but its entry has no createEngineAdapter.`);
  const withEnv = (ctx: ProviderContext): PluginContext => ({ ...ctx, env: pluginEnv });
  for (const p of providers) {
    registerProviderFactory(p, (ctx) => mod.createProvider!(withEnv(ctx)), mod.models ? (ctx) => mod.models!(withEnv(ctx)) : undefined);
  }
  // The engine config carries the API key; only a plug-in that declared ANTHROPIC_API_KEY gets it.
  const adapterConfig = (config: Parameters<AdapterFactory>[0]) => {
    if (required.includes("ANTHROPIC_API_KEY")) return config;
    const { apiKey: _drop, ...rest } = config as typeof config & { apiKey?: string };
    return rest as typeof config;
  };
  for (const p of engineProviders) {
    try { registerAdapter(p, (config) => mod.createEngineAdapter!({ env: pluginEnv, config: adapterConfig(config) })); }
    catch (e) { throw new Error(`Plug-in ${id}: ${(e as Error).message}; rename the engine provider.`); }
  }
}
