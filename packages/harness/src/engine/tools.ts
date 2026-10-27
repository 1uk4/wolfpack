/** Tool registry: wolf.yaml `tools:` names -> engine extensions + the tool names they provide. */
import { createCodingTools, type ImageLimits, type ImageProcessor, type PreparedImage } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { Extension } from "@earendil-works/pi-durable";
import { READONLY_TOOL_NAMES, ReadOnlyTools } from "./readonly-tools.js";

interface RegistryEntry {
  extension: Extension<never>;
  /** Tool names the extension registers (what `configure({tools})` selects). */
  tools: readonly string[];
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/**
 * Pixel size from an image header (PNG, GIF, JPEG, WebP). Undefined when the signature is wrong or the header is
 * truncated or unreadable: the caller must treat that as "not a usable image", never guess.
 */
export function headerSize(b: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  try {
    if (mime === "image/png") {
      if (b.length < 24 || b[0] !== 0x89 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return undefined;
      return size(v.getUint32(16), v.getUint32(20));
    }
    if (mime === "image/gif") {
      if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return undefined;
      return size(v.getUint16(6, true), v.getUint16(8, true));
    }
    if (mime === "image/jpeg") {
      if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return undefined;
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return size(v.getUint16(i + 7), v.getUint16(i + 5));
        i += 2 + v.getUint16(i + 2);
      }
      return undefined;
    }
    if (mime === "image/webp") {
      if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return undefined;
      const kind = ascii(b, 12, 4);
      if (kind === "VP8X") return size(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
      if (kind === "VP8 ") return size(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
      if (kind === "VP8L") {
        const bits = v.getUint32(21, true);
        return size(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
      }
    }
  } catch {
    /* truncated header */
  }
  return undefined;
}

/**
 * What `read` does without a processor: an image already within the limits passes through; anything else is
 * refused, saying whether it is too large or simply unreadable. Used when Photon cannot run here, so that never
 * turns into an opaque error.
 */
function passthrough(bytes: Uint8Array, mimeType: string, limits: ImageLimits, why: string): PreparedImage {
  const size = headerSize(bytes, mimeType);
  const unavailable = `the image processor is unavailable (${why})`;
  if (size === undefined) throw new Error(`unsupported or unreadable image, and ${unavailable}`);
  const mib = (limits.maxBytes / 1048576).toFixed(1);
  if (size.width > limits.maxWidth || size.height > limits.maxHeight || Math.ceil(bytes.length / 3) * 4 > limits.maxBytes) {
    throw new Error(`image too large to process here: it exceeds ${limits.maxWidth}x${limits.maxHeight} or ${mib} MiB and ${unavailable}; send a smaller image`);
  }
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

/** Failures no retry will fix: the environment cannot run Photon at all (e.g. no `import.meta.url` in a CJS bundle). */
const structural = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /import\.meta|reading 'endsWith'|\bfilename\b.*(undefined|must be)|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|wasm/i.test(m);
};

/**
 * Without a processor `read` rejects any image over 2000px a side or 4.5 MiB, which covers an ordinary retina
 * screenshot, so the model gets an error instead of the picture. Photon (WASM, in a worker thread) shrinks and
 * re-encodes to fit. Loaded on the first image so wolves that never read one do not pay for it. When it cannot be
 * used, `read` degrades to the no-processor behaviour with a clear message. A structural cause (Photon cannot
 * resolve its WASM or worker from a CJS bundle, which is the deployed harness today) is warned about once and
 * remembered for the process; a transient one is retried on the next image.
 */
export function lazyImageProcessor(load: () => Promise<ImageProcessor> = createNodePhotonImages): ImageProcessor {
  let loaded: Promise<ImageProcessor> | undefined;
  let worked = false;
  let unavailable: string | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      if (unavailable !== undefined) return passthrough(bytes, mimeType, limits, unavailable);
      try {
        const out = await (await (loaded ??= load())).prepare(bytes, mimeType, limits);
        worked = true;
        return out;
      } catch (e) {
        // Once it has handled an image, a failure is about that image: surface it.
        if (worked) throw e;
        loaded = undefined;
        const why = e instanceof Error ? e.message : String(e);
        if (structural(e)) {
          unavailable = why;
          console.warn(`[wolfd] image processor unavailable for this process: ${why}`);
        } else {
          console.warn(`[wolfd] image processor failed, will retry on the next image: ${why}`);
        }
        return passthrough(bytes, mimeType, limits, why);
      }
    },
  };
}

const CodingTools = createCodingTools({ images: lazyImageProcessor() });

const REGISTRY: Record<string, RegistryEntry> = {
  coding: { extension: CodingTools as unknown as Extension<never>, tools: ["read", "write", "edit", "bash"] },
  readonly: { extension: ReadOnlyTools as unknown as Extension<never>, tools: READONLY_TOOL_NAMES },
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
