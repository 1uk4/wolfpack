/**
 * embed-onnx — nomic-embed-text v1.5 (768 dims) run in-process through onnxruntime-node, so a Mac with no Ollama
 * (the friend install) can embed. Selected with WOLFPACK_EMBED_PROVIDER=onnx + WOLFPACK_EMBED_MODEL_DIR; Ollama stays the default.
 *
 * Route: onnxruntime-node + @huggingface/tokenizers (zero deps, 0.6 MB) rather than @huggingface/transformers, which would add
 * sharp and onnxruntime-web (a second runtime) for no gain: the pipeline here is tokenize → run → mean-pool → normalise.
 *
 * The model dir holds tokenizer.json, tokenizer_config.json and model.onnx (scripts/fetch-embed-model.mjs puts them there).
 * Only the fp32 model is supported: int8 drifts from Ollama's vectors.
 * Both packages are optional dependencies, imported lazily through a variable specifier, so no bundler tries to resolve or
 * inline the native .node files, and installs and bundles that only use Ollama never load them.
 * The caller supplies the text already prefixed (`search_document: `…) by embedInput, same as for Ollama.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InfraError } from "./backoff.js";

export const DEFAULT_ONNX_FILE = "model.onnx";

export interface OnnxEmbedOptions {
  /** Directory with tokenizer.json, tokenizer_config.json and the .onnx file. */
  modelDir: string;
  /** Model file inside modelDir (default model.onnx). */
  file?: string;
  /** onnxruntime intra-op threads (default: the runtime's choice). Set 1 on a 1-CPU host. */
  threads?: number;
}

// The slice of the two packages used here, typed locally (the imports are untyped on purpose) so `tsc` passes
// when the optional packages are not installed.
interface OrtTensor {
  data: unknown;
  dims: readonly number[];
  dispose(): void;
}
interface OrtModule {
  InferenceSession: {
    create(path: string, opts: Record<string, unknown>): Promise<{
      outputNames: readonly string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
    }>;
  };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}
interface TokenizersModule {
  Tokenizer: new (tokenizer: unknown, config: unknown) => { encode(text: string): { ids: number[] } };
}

// Variable specifiers on purpose: esbuild and other bundlers cannot bundle native .node addons, and leave these imports alone.
const ORT = "onnxruntime-node";
const TOKENIZERS = "@huggingface/tokenizers";

async function load<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (err) {
    throw new InfraError(`ONNX embedder: cannot load optional package ${name} (${err instanceof Error ? err.message : String(err)})`, { cause: err });
  }
}

/** Returns a function mapping a text to its mean-pooled raw (not yet normalised) embedding. Throws InfraError naming what is missing. */
export async function createOnnxEmbedFn(opts: OnnxEmbedOptions): Promise<(text: string) => Promise<number[]>> {
  const modelFile = join(opts.modelDir, opts.file ?? DEFAULT_ONNX_FILE);
  for (const f of [modelFile, join(opts.modelDir, "tokenizer.json"), join(opts.modelDir, "tokenizer_config.json")]) {
    if (!existsSync(f)) throw new InfraError(`ONNX embedder: missing ${f} (run scripts/fetch-embed-model.mjs ${opts.modelDir})`);
  }
  const ort = await load<OrtModule>(ORT);
  const { Tokenizer } = await load<TokenizersModule>(TOKENIZERS);
  const read = (f: string) => JSON.parse(readFileSync(join(opts.modelDir, f), "utf-8"));
  const tokenizer = new Tokenizer(read("tokenizer.json"), read("tokenizer_config.json"));
  const session = await ort.InferenceSession.create(modelFile, {
    executionProviders: ["cpu"],
    ...(opts.threads ? { intraOpNumThreads: opts.threads } : {}),
  });
  const output = session.outputNames[0];

  return async (text: string): Promise<number[]> => {
    // No token cap: embedInput already limits text to EMBED.inputMaxChars (4000 chars), far below the model's 8192-token window.
    const { ids } = tokenizer.encode(text);
    const n = ids.length;
    const out = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(ids, () => 1n), [1, n]),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(n), [1, n]),
    });
    const hidden = out[output];
    try {
      const data = hidden.data as Float32Array;
      const dim = hidden.dims[2];
      // Batch size is 1 with no padding, so the plain mean over tokens equals the mask-weighted mean pooling.
      const mean = new Array<number>(dim).fill(0);
      for (let t = 0; t < n; t++) for (let d = 0; d < dim; d++) mean[d] += data[t * dim + d];
      return mean.map((x) => x / n);
    } finally {
      hidden.dispose();
    }
  };
}
