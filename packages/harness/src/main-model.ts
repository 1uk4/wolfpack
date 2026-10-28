/**
 * Provider choice for the pi-durable VPS harness main agent. subscription transport + a Max OAuth token → the
 * pi-claude-bridge provider (same factory wolfd uses); otherwise, or if the bridge cannot start, pi-ai's anthropic
 * provider on the API key.
 *
 * The registry handed to the Harness is a stable facade whose target can be swapped (`fallBackToApi`), because the
 * Harness is opened once. While the bridge is the target the registry holds ONLY the bridge (a failed turn never
 * spills onto the metered key) and `getModel("anthropic", id)` is aliased to the bridge's model of the same id: the
 * den may hold conversations, subagent children and in-flight checkpoints that stored provider "anthropic" from when
 * the wolf ran on the API key, and the Harness resolves every stored model ref through `models.getModel`.
 */
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { loadQuery, type ModelTable } from "@wolfpack/engine";
import { BRIDGE_PROVIDER_ID, createBridgeModels, type BuildWolfModelsOptions } from "./wolfd/models.js";

export interface MainModelChoice {
  via: "bridge" | "api";
  /** Stable registry for Harness.open; follows the current choice (see fallBackToApi). */
  models: Models;
  model: { provider: string; modelId: string };
  /** One startup line: "Main agent via Max subscription (claude-bridge)" / "Main agent via API key (reason)". */
  line: string;
  /** Set when the bridge was wanted but failed. */
  warning?: string;
  shutdown(): void;
  release(sessionId: string): void;
  /** Bridge → API key at runtime (e.g. root.configure rejected the bridge model). No-op when already on the API. */
  fallBackToApi(reason: string, warning?: string): void;
}

export interface SelectMainModelOptions {
  table: Pick<ModelTable, "transport" | "tiers">;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seams. */
  createProvider?: BuildWolfModelsOptions["createProvider"];
  loadSdkQuery?: () => Promise<unknown>;
  warn?: (line: string) => void;
}

/**
 * Registry facade. `alias()` names the provider whose stored refs must resolve on the other one: on the bridge,
 * "anthropic" refs map to claude-bridge; on the API, "claude-bridge" refs map to anthropic (a rolled-back or fallen-back
 * wolf still holds conversations stored under the other name). A miss on the aliased lookup is never silent: neither
 * provider has a resolver for non-table ids (dated snapshots such as claude-haiku-4-5-20251001), so it warns once
 * naming the provider and id, and returns undefined.
 */
function facade(current: () => Models, alias: () => { from: string; to: string }, warn: (l: string) => void): Models {
  const warned = new Set<string>();
  return new Proxy({} as Models, {
    get(_t, prop) {
      const target = current() as any;
      if (prop === "getModel") {
        return (provider: string, id: string) => {
          const a = alias();
          if (provider !== a.from) return target.getModel(provider, id);
          const hit = target.getModel(a.to, id);
          if (!hit) {
            const key = `${provider}/${id}`;
            if (!warned.has(key)) {
              warned.add(key);
              warn(`[harness] stored model ref ${provider}/${id} has no model "${id}" in the ${a.to} table; conversations using it will fail to resolve`);
            }
          }
          return hit;
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export async function selectMainModel(opts: SelectMainModelOptions): Promise<MainModelChoice> {
  const env = opts.env ?? process.env;
  const modelId = opts.table.tiers.main.model;
  let target: Models;
  let bridge: ReturnType<typeof createBridgeModels> | undefined;

  const apiModels = () => {
    const m = createModels();
    m.setProvider(anthropicProvider());
    return m;
  };
  const choice: MainModelChoice = {
    via: "api",
    models: facade(() => target, () => (bridge ? { from: "anthropic", to: BRIDGE_PROVIDER_ID } : { from: BRIDGE_PROVIDER_ID, to: "anthropic" }), (l) => (opts.warn ?? console.warn)(l)),
    model: { provider: "anthropic", modelId },
    line: "",
    shutdown: () => { const b = bridge; bridge = undefined; b?.shutdown(); },
    release: (id) => bridge?.release(id),
    fallBackToApi(reason, warning?: string) {
      choice.shutdown();
      target = apiModels();
      choice.via = "api";
      choice.model = { provider: "anthropic", modelId };
      choice.line = `Main agent via API key (${reason})`;
      if (warning) choice.warning = warning;
    },
  } as MainModelChoice;

  if (opts.table.transport !== "subscription") { target = apiModels(); choice.line = "Main agent via API key (transport api)"; return choice; }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) { target = apiModels(); choice.line = "Main agent via API key (no CLAUDE_CODE_OAUTH_TOKEN)"; return choice; }
  try {
    // The Agent SDK cannot be bundled; resolve it from the host (NODE_PATH, global install) and hand it to the bridge.
    const query = (await (opts.loadSdkQuery ?? loadQuery)()) as NonNullable<Parameters<typeof createBridgeModels>[0]["queryFn"]>;
    bridge = createBridgeModels({ cwd: opts.cwd, env, queryFn: query, ...(env.WOLF_HARNESS_SMOKE ? { sweepOrphans: false } : {}), ...(opts.createProvider ? { createProvider: opts.createProvider } : {}) });
    // The model must exist in the bridge's table, or every turn (and root.configure) would fail with "model not found".
    if (!bridge.models.getModel(BRIDGE_PROVIDER_ID, modelId)) {
      throw new Error(`model "${modelId}" is not in the claude-bridge model table`);
    }
    target = bridge.models;
    choice.via = "bridge";
    choice.model = { provider: BRIDGE_PROVIDER_ID, modelId };
    choice.line = "Main agent via Max subscription (claude-bridge)";
    return choice;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    choice.fallBackToApi(`bridge unavailable: ${msg}`, `claude-bridge failed to initialise, falling back to the API key: ${msg}`);
    return choice;
  }
}

type RootLike = { configure(...args: any[]): Promise<unknown> };

/**
 * Open the root conversation on the chosen provider and (re)apply the model. A bridge failure at either step switches
 * the harness to the API key and retries, so a bridge that initialised but cannot serve the model never leaves the
 * wolf without a working main agent. An API-key failure is only logged (as before).
 */
export async function startRoot<R extends RootLike>(
  choice: MainModelChoice,
  open: (agent: { model: { provider: string; modelId: string } }) => Promise<R>,
  thinking: string | undefined,
  ctx: unknown,
  log: { warn: (l: string) => void } = { warn: (l) => console.warn(l) },
): Promise<R> {
  const switchToApi = (what: string, err: unknown) => {
    choice.fallBackToApi(`bridge failed: ${what}`, `claude-bridge ${what}, falling back to the API key: ${err instanceof Error ? err.message : err}`);
    log.warn(`[harness] ${choice.warning}`);
    log.warn(`[harness] ${choice.line}`);
  };
  let root: R;
  try {
    root = await open({ model: choice.model });
  } catch (err) {
    if (choice.via !== "bridge") throw err;
    switchToApi("could not open the root conversation", err);
    root = await open({ model: choice.model });
  }
  // open() applies the model only when it creates the conversation; an existing root keeps the one it was created
  // with, so re-apply on every start: the shipped table (models.json) decides the model, not history.
  try {
    await root.configure({ model: choice.model, thinkingLevel: thinking ?? null }, ctx);
  } catch (err) {
    if (choice.via === "bridge") {
      switchToApi("rejected the main model", err);
      try {
        await root.configure({ model: choice.model, thinkingLevel: thinking ?? null }, ctx);
      } catch (err2) {
        console.error(`[harness] Could not re-apply the main model to the root: ${err2 instanceof Error ? err2.message : err2}`);
      }
    } else {
      console.error(`[harness] Could not re-apply the main model to the root: ${err instanceof Error ? err.message : err}`);
    }
  }
  return root;
}
