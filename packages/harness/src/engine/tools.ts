/** Tool registry: wolf.yaml `tools:` names -> engine extensions + the tool names they provide. */
import { createCodingTools, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { Extension } from "@earendil-works/pi-durable";

interface RegistryEntry {
  extension: Extension<never>;
  /** Tool names the extension registers (what `configure({tools})` selects). */
  tools: readonly string[];
}

/**
 * Without a processor `read` rejects any image over 2000px a side or 4.5 MiB, which covers an ordinary retina
 * screenshot, so the model gets an error instead of the picture. Photon (WASM, in a worker thread) shrinks and
 * re-encodes to fit. Loaded on the first image so wolves that never read one do not pay for it.
 */
export function lazyImageProcessor(load: () => Promise<ImageProcessor> = createNodePhotonImages): ImageProcessor {
  let loaded: Promise<ImageProcessor> | undefined;
  return { prepare: async (bytes, mimeType, limits) => (await (loaded ??= load())).prepare(bytes, mimeType, limits) };
}

const CodingTools = createCodingTools({ images: lazyImageProcessor() });

const REGISTRY: Record<string, RegistryEntry> = {
  coding: { extension: CodingTools as unknown as Extension<never>, tools: ["read", "write", "edit", "bash"] },
};

export const TOOL_REGISTRY_NAMES: readonly string[] = Object.keys(REGISTRY);

export interface ResolvedTools {
  /** Pass as `openWolfEngine({ extensions })`. */
  extensions: Extension[];
  /** Pass as `configure({ tools })`. */
  tools: string[];
}

/** Resolve registry names; throws on an unknown name. Grows by demand (ADR 003 buckets apply). */
export function resolveToolNames(names: readonly string[]): ResolvedTools {
  const extensions: Extension[] = [];
  const tools: string[] = [];
  for (const n of names) {
    const entry = REGISTRY[n];
    if (!entry) throw new Error(`unknown tool registry name "${n}" (known: ${TOOL_REGISTRY_NAMES.join(", ")})`);
    extensions.push(entry.extension as unknown as Extension);
    tools.push(...entry.tools);
  }
  return { extensions, tools };
}
