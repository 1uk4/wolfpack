import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ProviderFactory } from "./types.js";

/** pi-ai's anthropic provider on the metered API (reads ANTHROPIC_API_KEY). */
export const anthropicFactory: ProviderFactory = () => ({ provider: anthropicProvider() });

/** Model list for a lookup-only anthropic provider (no key, no network). */
export const anthropicLookupModels = () => anthropicProvider().getModels();
