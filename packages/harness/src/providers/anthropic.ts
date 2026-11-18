import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ProviderFactory } from "./types.js";

let announced = false;

/**
 * WOLFPACK_ANTHROPIC_BASE_URL (ours, not the Anthropic SDK's ANTHROPIC_BASE_URL, which Claude Code sets in shells):
 * https anywhere, or http on loopback only. Anything else is ignored with a warning, so the key can never go out in clear text.
 */
export function anthropicBaseUrlOverride(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.WOLFPACK_ANTHROPIC_BASE_URL?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    console.warn("wolfd: WOLFPACK_ANTHROPIC_BASE_URL is not a URL; ignored");
    return undefined;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) {
    console.warn("wolfd: WOLFPACK_ANTHROPIC_BASE_URL must be https, or http on loopback; ignored");
    return undefined;
  }
  if (!announced) {
    announced = true;
    console.warn(`wolfd: anthropic requests go to ${u.origin} (WOLFPACK_ANTHROPIC_BASE_URL)`);
  }
  return raw;
}

/**
 * pi-ai's anthropic provider on the metered API (reads ANTHROPIC_API_KEY).
 * WOLFPACK_ANTHROPIC_BASE_URL points every request at another host, e.g. in the desktop app's tests a fake model on
 * 127.0.0.1. pi-ai bakes https://api.anthropic.com into its models, so the override is applied where requests are made.
 */
export const anthropicFactory: ProviderFactory = (ctx) => {
  const provider = anthropicProvider();
  const baseUrl = anthropicBaseUrlOverride(ctx.env);
  if (!baseUrl) return { provider };
  return {
    provider: {
      ...provider,
      stream: (model, context, options) => provider.stream({ ...model, baseUrl } as never, context, options as never),
      streamSimple: (model, context, options) => provider.streamSimple({ ...model, baseUrl } as never, context, options as never),
    },
  };
};

/** Model list for a lookup-only anthropic provider (no key, no network). */
export const anthropicLookupModels = () => anthropicProvider().getModels();
