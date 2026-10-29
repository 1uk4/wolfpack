import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * A provider's stream() must report failure as an `error` stream event, never by throwing or rejecting: on the VPS
 * harness an unhandled rejection exits the process (crash loop). This covers ONLY a synchronous throw out of
 * stream()/streamSimple(); the harness crash guard handles detached rejections after startup.
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
