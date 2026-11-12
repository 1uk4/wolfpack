/**
 * Live seam (pnpm test:live, this Mac only): one KB curation window in the app's own hubd, with the real local ONNX embedder
 * (~550 MB, fetch it with scripts/fetch-embed-model.mjs <dir>) and a fake Anthropic server on 127.0.0.1.
 * Needs WOLFPACK_APP_EMBED_MODEL_DIR and the built runtime (node apps/desktop/scripts/build-runtime.mjs).
 * Children run under this process's Node when WOLFPACK_DESKTOP_TEST_NODE=1, else under the Electron binary (as supervisor.test.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const { createSupervisor } = createRequire(import.meta.url)("./supervisor.cjs");
const runtimeDir = join(here, "..", "runtime");

function nodeBin(): string {
  if (process.env.WOLFPACK_DESKTOP_TEST_NODE === "1") return process.execPath;
  const electronDir = join(here, "..", "node_modules", "electron");
  const pathTxt = join(electronDir, "path.txt");
  if (!existsSync(pathTxt)) throw new Error("Electron binary is not installed, or set WOLFPACK_DESKTOP_TEST_NODE=1 to use this Node");
  return join(electronDir, "dist", readFileSync(pathTxt, "utf8"));
}

const CURATED = { section: "NEW", match: "new", reason: "different", title: "Tea tin", kind: { type: "fact" }, summary: "A fake summary.", detail: "Fake detail.", confidence: "high", facets: {}, properties: {}, proposedRelations: [] };
const seenModels: string[] = [];
let fake: Server;
let fakeUrl: string;

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seenModels.push(String(parsed.model));
      const msg = { id: "msg_fake", type: "message", role: "assistant", model: String(parsed.model), content: [{ type: "text", text: JSON.stringify(CURATED) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } };
      if (parsed.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify(CURATED) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => fake?.close(r));
});

describe("KB curation window on one Mac", () => {
  it("curates a contribution into the app's own KB with Haiku and local ONNX, never Ollama", async () => {
    const modelDir = process.env.WOLFPACK_APP_EMBED_MODEL_DIR;
    if (!modelDir || !existsSync(join(modelDir, "model.onnx"))) throw new Error("Set WOLFPACK_APP_EMBED_MODEL_DIR to a folder holding the embedding model (model.onnx); see scripts/fetch-embed-model.mjs");
    // The bundles keep onnxruntime-node and @huggingface/tokenizers external (the packaged app ships them in <runtime>/node_modules): link the workspace copies, remove only the links made here.
    const kbModules = join(here, "..", "..", "..", "packages", "kb", "node_modules");
    const made: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "app-sup-cur-"));
    let sup: ReturnType<typeof createSupervisor> | undefined;
    try {
      for (const pkg of ["onnxruntime-node", "@huggingface/tokenizers"]) {
        const dest = join(runtimeDir, "node_modules", pkg);
        let exists = true;
        try { lstatSync(dest); } catch { exists = false; }
        if (exists) continue;
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(join(kbModules, pkg), dest);
        made.push(dest);
      }
      sup = createSupervisor({
        stateDir: join(dir, "state"), wolvesDir: join(dir, "Wolves"), runtimeDir, nodeBin: nodeBin(), apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl,
        embedModelDir: modelDir, embedThreads: 2, curateWindowMax: 2,
        extraEnv: { WOLFPACK_EMBED_URL: "http://127.0.0.1:9", HUBD_OLLAMA_URL: "http://127.0.0.1:9" }, // a dead port: any Ollama call would fail the sweep
      });
      await sup.start();
      const tokenFile = join(dir, "state", "hub-token.json");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      const token = JSON.parse(readFileSync(tokenFile, "utf8")).token;
      const auth = { authorization: `Bearer ${token}` };
      const graphNodes = async () => (((await (await fetch(`${sup!.urls.hubd}/v1/kb/graph?domain=personal`, { headers: auth })).json()).nodes ?? []) as Array<{ id: string }>).filter((n) => n.id.startsWith("ent:")); // entry nodes (the graph also has domain nodes)
      expect(await graphNodes()).toHaveLength(0); // nothing curated yet

      const body = "# Tea tin\n\nThe user keeps their tea in the blue tin.";
      const sub = await fetch(`${sup.urls.hubd}/v1/contributions`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ from: "wolf", denTopicId: "tea-tin", change: "create", contentHash: `sha256:${createHash("sha256").update(body).digest("hex")}`, prevHash: null, domainHint: "personal", summary: "Where the tea lives", submitted: "2026-11-11 10:00", body, origin: "crawl", sourcePath: "/s" }),
      });
      expect(sub.status).toBe(201);
      seenModels.length = 0;

      const out = await sup.curate();
      expect(out.line).toMatch(/processed=1 remaining=0 stop=empty/);
      expect(await graphNodes()).toHaveLength(1); // the contribution became a KB entry
      expect(seenModels.length).toBeGreaterThan(0);
      for (const m of seenModels) expect(m).toContain("haiku");
    } finally {
      await sup?.stop();
      rmSync(dir, { recursive: true, force: true });
      for (const l of made) unlinkSync(l);
    }
  }, 240_000);
});
