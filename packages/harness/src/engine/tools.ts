/** Tool registry: wolf.yaml `tools:` names -> engine extensions + the tool names they provide. */
import { createCodingTools, type ImageLimits, type ImageProcessor, type PreparedImage } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { Extension } from "@earendil-works/pi-durable";

interface RegistryEntry {
  extension: Extension<never>;
  /** Tool names the extension registers (what `configure({tools})` selects). */
  tools: readonly string[];
}

/** Pixel size from an image header (PNG, GIF, JPEG, WebP), or undefined when it cannot be read. */
function headerSize(b: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (mime === "image/png") return { width: v.getUint32(16), height: v.getUint32(20) };
    if (mime === "image/gif") return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
    if (mime === "image/jpeg") {
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return undefined;
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
        i += 2 + v.getUint16(i + 2);
      }
      return undefined;
    }
    if (mime === "image/webp") {
      const kind = String.fromCharCode(...b.subarray(12, 16));
      if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (kind === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
      if (kind === "VP8L") { const bits = v.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
    }
  } catch {
    /* truncated header */
  }
  return undefined;
}

/**
 * What `read` does without a processor: an image already within the limits passes through; anything else is
 * refused. Used when Photon cannot load here, so a failure to load never turns into an opaque error.
 */
function passthrough(bytes: Uint8Array, mimeType: string, limits: ImageLimits, why: string): PreparedImage {
  const size = headerSize(bytes, mimeType);
  const ok = size !== undefined && size.width <= limits.maxWidth && size.height <= limits.maxHeight && Math.ceil(bytes.length / 3) * 4 <= limits.maxBytes;
  if (!ok) throw new Error(`image too large to process here: it exceeds ${limits.maxWidth}x${limits.maxHeight} or ${(limits.maxBytes / 1048576).toFixed(1)} MiB and the image processor is unavailable (${why}); send a smaller image`);
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

/**
 * Without a processor `read` rejects any image over 2000px a side or 4.5 MiB, which covers an ordinary retina
 * screenshot, so the model gets an error instead of the picture. Photon (WASM, in a worker thread) shrinks and
 * re-encodes to fit. Loaded on the first image so wolves that never read one do not pay for it. A failed load is
 * not cached (the next image retries) and degrades to the no-processor behaviour with a clear message. Photon
 * cannot load from the esbuild CJS harness bundle (no import.meta.url), so that is the deployed behaviour today.
 */
export function lazyImageProcessor(load: () => Promise<ImageProcessor> = createNodePhotonImages): ImageProcessor {
  let loaded: Promise<ImageProcessor> | undefined;
  let worked = false;
  return {
    async prepare(bytes, mimeType, limits) {
      try {
        const out = await (await (loaded ??= load())).prepare(bytes, mimeType, limits);
        worked = true;
        return out;
      } catch (e) {
        // Once the processor has handled an image, a failure is about that image: surface it. Before that, a failure
        // (a rejected load, or a processor that constructs but cannot start, as Photon's does in the CJS bundle)
        // means it is unavailable: forget it so a later image retries, and degrade.
        if (worked) throw e;
        loaded = undefined;
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[wolfd] image processor unavailable: ${why}`);
        return passthrough(bytes, mimeType, limits, why);
      }
    },
  };
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
