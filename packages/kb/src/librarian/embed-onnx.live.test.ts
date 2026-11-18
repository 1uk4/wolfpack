import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEmbedder, embedInput, cosine } from "./embed.js";
import type { KbRoots } from "../shared/index.js";

// Live: needs the fp32 model files. node scripts/fetch-embed-model.mjs <dir>, then WOLFPACK_EMBED_MODEL_DIR=<dir>.
const modelDir = process.env.WOLFPACK_EMBED_MODEL_DIR;

// Full 768-dim unit vector Ollama's nomic-embed-text:latest gave for this text (captured 2026-11-11).
const fixture = JSON.parse(readFileSync(new URL("./embed-onnx.ollama-fixture.json", import.meta.url), "utf-8")) as { text: string; unitVector: number[] };

describe("in-process ONNX embedder", () => {
  let base = "";
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("gives the same 768-dim vector Ollama gives (cosine >= 0.999), without any network call", async () => {
    expect(modelDir, "set WOLFPACK_EMBED_MODEL_DIR to a dir from scripts/fetch-embed-model.mjs").toBeTruthy();
    base = mkdtempSync(join(tmpdir(), "kb-onnx-"));
    const roots: KbRoots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    // Dead port: any Ollama call would throw.
    const e = createEmbedder(roots, { baseUrl: "http://127.0.0.1:9", model: "nomic-embed-text", provider: "onnx", modelDir: modelDir! });
    const text = embedInput({ title: "Hello", summary: "world", role: "document", model: "nomic-embed-text" });
    expect(text).toBe(fixture.text);

    const v = await e.embed(text, "h");
    expect(v).toHaveLength(768);
    expect(Math.hypot(...v)).toBeCloseTo(1, 4);
    expect(cosine(v, fixture.unitVector)).toBeGreaterThanOrEqual(0.999);
  });
});
