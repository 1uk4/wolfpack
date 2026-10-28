/**
 * Engine model registry for a wolf's resolved transport. api: undefined (the engine's default anthropic provider,
 * which reads ANTHROPIC_API_KEY). subscription: a registry holding only the pi-claude-bridge provider — no anthropic
 * provider is registered, so a failed subscription turn can never fall over onto the metered key.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createClaudeBridgeProvider, PROVIDER_ID, type ClaudeBridgeProvider, type ClaudeBridgeProviderOptions } from "pi-claude-bridge/core";
import type { ResolvedWolfModel } from "@wolfpack/engine";
import type { WolfEngineOptions } from "../engine/index.js";

export interface WolfModels {
  models?: WolfEngineOptions["models"];
  /** Kills any parked SDK queries. Call on wolf shutdown. */
  shutdown(): void;
  /** Close the claude children parked for one conversation (its provider session id). No-op on the metered API transport. */
  release(sessionId: string): void;
}

export interface BuildWolfModelsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the real bridge provider factory. */
  createProvider?: (opts: ClaudeBridgeProviderOptions) => ClaudeBridgeProvider;
}

export const NO_TOOL_SEARCH = { ENABLE_TOOL_SEARCH: "false" } as const;

/**
 * The bridge-only registry (provider + shutdown/release), shared by wolfd and the VPS harness so both pick the
 * provider the same way. Throws if the bridge cannot be created; callers decide whether that is fatal.
 */
export function createBridgeModels(opts: BuildWolfModelsOptions & { queryFn?: ClaudeBridgeProviderOptions["queryFn"]; sweepOrphans?: boolean }): Required<WolfModels> {
  // Env hygiene (stripping ANTHROPIC_API_KEY from the claude child) is done inside the bridge core.
  // ENABLE_TOOL_SEARCH=false: the bridge runs claude with `tools: []`, which removes ToolSearch, yet Claude Code
  // still defers MCP tool schemas behind it (the SDK's default for MCP servers). The model then sees task_bind etc.
  // by name only and has no way to load the schema. Inline schemas for every tool the host hands us.
  const provider = (opts.createProvider ?? createClaudeBridgeProvider)({
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), ...NO_TOOL_SEARCH },
    ...(opts.queryFn ? { queryFn: opts.queryFn } : {}),
    ...(opts.sweepOrphans === false ? { sweepOrphans: false } : {}),
  });
  guardProviderStreams(provider, { provider: PROVIDER_ID });
  const models = createModels();
  models.setProvider(provider);
  return { models, shutdown: () => provider.shutdown(), release: (sessionId) => void provider.release(sessionId) };
}

/**
 * A provider's stream() must report failure as an `error` stream event, never by throwing or rejecting: on the VPS
 * harness an unhandled rejection exits the process (crash loop). The bridge already maps SDK errors to error events;
 * this covers ONLY a synchronous throw out of stream()/streamSimple(). It does not catch a rejection from a detached
 * promise (the harness crash guard handles those after startup).
 */
export function guardProviderStreams<P extends { stream: (...a: any[]) => any; streamSimple: (...a: any[]) => any }>(provider: P, ids: { provider: string; api?: string }): P {
  const guard = (orig: (...a: any[]) => any) => (model: any, ...rest: any[]) => {
    try {
      return orig.call(provider, model, ...rest);
    } catch (err) {
      const out = createAssistantMessageEventStream();
      const message = err instanceof Error ? err.message : String(err);
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const error = { role: "assistant", content: [], api: model?.api ?? ids.api ?? ids.provider, provider: model?.provider ?? ids.provider, model: model?.id ?? "unknown", usage: zero, stopReason: "error", errorMessage: message, timestamp: Date.now() };
      queueMicrotask(() => { out.push({ type: "error", reason: "error", error } as never); out.end(); });
      return out;
    }
  };
  provider.stream = guard(provider.stream);
  provider.streamSimple = guard(provider.streamSimple);
  return provider;
}

export function buildWolfModels(model: Pick<ResolvedWolfModel, "transport" | "provider">, opts: BuildWolfModelsOptions): WolfModels {
  if (model.transport !== "subscription") return { shutdown: () => {}, release: () => {} };
  if (model.provider !== PROVIDER_ID) {
    throw new Error(`subscription transport resolved provider "${model.provider}", expected "${PROVIDER_ID}"`);
  }
  return createBridgeModels(opts);
}

export { PROVIDER_ID as BRIDGE_PROVIDER_ID };
