import type { Models, Provider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

type Model = ReturnType<Models["getModels"]>[number];

/**
 * A lookup-only provider: lists models (so a stored `provider/model` ref in the den still resolves through
 * `models.getModel`) but never serves a turn — stream() returns an error event. Models are listed lazily on first
 * lookup, so registering one costs nothing until the Harness resolves a stored ref.
 */
export function lookupOnlyProvider(id: string, listModels: () => readonly Model[]): Provider {
  let cached: readonly Model[] | undefined;
  const getModels = () => (cached ??= (() => { try { return listModels(); } catch { return []; } })());
  const stream = (model: any) => {
    const out = createAssistantMessageEventStream();
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const error = { role: "assistant", content: [], api: model?.api ?? id, provider: id, model: model?.id ?? "unknown", usage: zero, stopReason: "error", errorMessage: `provider ${id} is not configured for this wolf`, timestamp: Date.now() };
    queueMicrotask(() => { out.push({ type: "error", reason: "error", error } as never); out.end(); });
    return out;
  };
  return {
    id,
    name: `${id} (lookup only)`,
    auth: { apiKey: { name: id, check: async () => undefined, resolve: async () => ({ auth: { apiKey: "lookup-only" }, source: "lookup-only" }) } },
    getModels,
    stream,
    streamSimple: stream,
  } as unknown as Provider;
}
