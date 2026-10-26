/**
 * wolfd loads the wolf's configured extensions (work-wolfpack-uqvMfZ7).
 *
 * Boots through startWolf from a wolf.yaml with `extensions: [memory]` and NO injected extensions: the memory extension
 * comes from `<den>/extensions/wolfpack-memory/index.js` (an esbuild bundle of durable.ts, as `wolfpack sync` ships it)
 * through the harness loader, and builds its REAL memory Engine (createEngine -> Anthropic adapter -> the models.json
 * tiers). The memory engine does not use the wolf's pi-ai model registry (so the scripted provider cannot answer it); the
 * narrowest seam below the real code is the Anthropic HTTP endpoint (ANTHROPIC_BASE_URL), answered by a local fake.
 * The wolf's own turns still run on the scripted provider.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { HttpConsoleClient } from "@wolfpack/client";
import { ConsolidateResponseSchema, MemoryEventSchema, PROTOCOL_VERSION, type MemoryEvent } from "@wolfpack/protocol";
import { defineExtension } from "@wolfpack/harness/extension";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { createScriptedModel, fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startWolf, type RunningWolf } from "../../packages/harness/src/wolfd/run.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `wolfd-ext-${p}-`));
  dirs.push(d);
  return d;
};

// ─── fake Anthropic endpoint: answers the memory pipeline's JSON-extraction calls ──────────────────────────────────
const requests: { model: string; system: string; prompt: string }[] = [];
let fake: Server;
let fakeUrl: string;

function answer(system: string, prompt: string): unknown {
  if (system.includes('"observations"')) return { observations: [{ timestamp: "2026-10-26 10:00", content: `Obs ${prompt.includes("MARK_WOLFD") ? "MARK_WOLFD" : "none"}` }] };
  if (system.includes('"actions"')) {
    return { actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups." } }] };
  }
  if (system.includes('"contributions"')) return { contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups." }] };
  throw new Error(`fake anthropic: unexpected prompt ${system.slice(0, 80)}`);
}

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; system: string | { text: string }[]; messages: { content: string }[] };
      const system = typeof body.system === "string" ? body.system : body.system.map((b) => b.text).join("\n");
      const prompt = String(body.messages[0]?.content);
      requests.push({ model: body.model, system, prompt });
      const text = JSON.stringify(answer(system, prompt));
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => fake.close(() => r())));

let wolf: RunningWolf | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await wolf?.close();
  wolf = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  requests.length = 0;
});

async function bundleMemoryInto(den: string): Promise<void> {
  const out = join(den, "extensions", "wolfpack-memory", "index.js");
  await esbuild.build({
    entryPoints: [join(__dirname, "durable.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "grammy"],
    logLevel: "silent",
  });
}

/** A minimal live tree -> snapshot dev root, with the memory extension bundled into the dev den. */
async function sandboxRoot(): Promise<{ dev: string; kb: string }> {
  const root = tmp("live");
  const work = join(root, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "fixture" });
  await (await fetch(`${srv.url}/work`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "fixture" }, body: JSON.stringify({ kind: "feature", domain: "wolfpack", title: "f", assignee: "owner" }) })).json();
  await srv.close();
  mkdirSync(join(root, "ops", "inbox", "boot"), { recursive: true });
  mkdirSync(join(root, "den"), { recursive: true });
  const kb = join(root, "kb");
  mkdirSync(join(kb, "domains", "wolfpack", "entries"), { recursive: true });
  writeFileSync(join(kb, "domains.yaml"), "domains:\n  wolfpack:\n    label: Wolfpack\n    description: The wolf system\n");
  writeFileSync(join(kb, "domains", "wolfpack", "INDEX.md"), "# wolfpack\n");
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(root, "ops"), denDir: join(root, "den") }, devRoot: dev });
  await bundleMemoryInto(join(dev, "den"));
  return { dev, kb };
}

const say = (marker: string) => `${marker}: we decided to cache the session lookups for five minutes because the profile endpoint was the hot path.`;
const post = (url: string, action: "consolidate" | "promote") =>
  fetch(`${url}/v1/wolves/boot/memory/${action}`, { method: "POST", headers: { "X-Protocol-Version": String(PROTOCOL_VERSION) } });

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function wolfYaml(root: string, extra: string): string {
  return `name: boot\nworkspace: ${root}\ndomains: [wolfpack]\nextensions: [memory]\n${extra}`;
}

/** models.json: main on the scripted provider, smart/fast on the real anthropic adapter (answered by the fake). */
function writeModels(root: string, scriptedTier: { model: string; provider: string }): string {
  const tier = (model: string, provider: string) => ({ model, modelSource: "default", provider, piModel: `${provider}/${model}` });
  const file = join(root, "models.json");
  const real = tier("claude-haiku-5-5", "anthropic");
  writeFileSync(file, JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier(scriptedTier.model, scriptedTier.provider), smart: real, fast: real }, steps: {}, warnings: [] }));
  return file;
}

describe("wolfd loads configured extensions", { timeout: 60_000 }, () => {
  it("memory from wolf.yaml extensions: observes a turn, consolidate 200, promote 202 (real engine path, fake endpoint)", async () => {
    vi.stubEnv("PI_SUBAGENT_AGENT", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", fakeUrl);
    const { dev, kb } = await sandboxRoot();
    const root = tmp("wolf");
    const scripted = createScriptedModel([fauxAssistantMessage(say("MARK_WOLFD"))]);
    const models = writeModels(root, { model: scripted.modelId, provider: scripted.provider });
    writeFileSync(join(root, "wolf.yaml"), wolfYaml(root, `sandbox:\n  root: ${dev}\nmemory:\n  consolidation:\n    trigger: manual\n    threshold: 20\n    poolTarget: 1\n`));
    const logs: string[] = [];
    wolf = await startWolf({
      configPath: join(root, "wolf.yaml"),
      env: { WOLFPACK_MODELS_FILE: models, ANTHROPIC_API_KEY: "test-key", KB_BASE: kb },
      home: root,
      models: scripted.models,
      log: (l) => logs.push(l),
    });
    expect(logs.join("\n")).toContain("Extension wolfpack-memory loaded");
    const den = wolf.config.den;
    expect(den.startsWith(dev)).toBe(true);

    const client = new HttpConsoleClient({ baseUrl: wolf.url });
    const events: MemoryEvent[] = [];
    const ctl = new AbortController();
    (async () => {
      for await (const e of client.watchMemory!("boot", { signal: ctl.signal })) events.push(MemoryEventSchema.parse(e));
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    await client.submit("boot/home", say("MARK_WOLFD user words"), { whenBusy: "reject" });
    for await (const _ of client.watch("boot/home")) void _;
    await waitFor(() => events.some((e) => e.type === "observation_captured"));
    expect(events[0]).toMatchObject({ type: "observation_captured", wolf: "boot", threadId: "boot/home", target: { kind: "den" } });
    // the real engine asked the (fake) endpoint, on the models.json tier model
    expect(requests.some((r) => r.system.includes('"observations"') && r.prompt.includes("MARK_WOLFD"))).toBe(true);
    expect(requests[0]!.model).toBe("claude-haiku-5-5");
    expect(readFileSync(join(den, ".memory", "pool", "observations.jsonl"), "utf8")).toContain("MARK_WOLFD");

    const res = await post(wolf.url, "consolidate");
    expect(res.status).toBe(200);
    expect(ConsolidateResponseSchema.parse(await res.json())).toMatchObject({ topicsCreated: 1, topicIds: ["caching"] });
    expect(readdirSync(join(den, ".memory", "sessions", "durable"))).toContain("caching.md");

    const p = await post(wolf.url, "promote");
    expect(p.status).toBe(202);
    await waitFor(() => events.some((e) => e.type === "promote_finished"));
    expect(readdirSync(join(dev, "ops", "inbox", "boot")).length).toBeGreaterThan(0);
    ctl.abort();
  });

  it("an explicit extraExtensions entry named wolfpack-memory replaces the configured one (loaded once)", async () => {
    vi.stubEnv("PI_SUBAGENT_AGENT", "");
    const { dev } = await sandboxRoot();
    const root = tmp("wolf");
    const scripted = createScriptedModel([fauxAssistantMessage(say("MARK_ONCE"))]);
    const models = writeModels(root, { model: scripted.modelId, provider: scripted.provider });
    writeFileSync(join(root, "wolf.yaml"), wolfYaml(root, `sandbox:\n  root: ${dev}\n`));
    const logs: string[] = [];
    wolf = await startWolf({
      configPath: join(root, "wolf.yaml"),
      env: { WOLFPACK_MODELS_FILE: models },
      home: root,
      models: scripted.models,
      log: (l) => logs.push(l),
      extraExtensions: [adaptToDurable(defineExtension({ name: "wolfpack-memory", runtimes: ["pi-durable"] }), { wolfDen: "-", wolfName: "boot" })],
    });
    expect(logs.join("\n")).not.toContain("Extension wolfpack-memory loaded");
    expect(existsSync(join(wolf.config.den, ".memory"))).toBe(false); // the configured one never started
    // inert: no memory routes
    expect((await post(wolf.url, "consolidate")).status).toBe(409);
  });

  it("a configured extension that is not installed is a warning, not a failure", async () => {
    const root = tmp("wolf");
    const scripted = createScriptedModel([]);
    const models = writeModels(root, { model: scripted.modelId, provider: scripted.provider });
    writeFileSync(join(root, "wolf.yaml"), wolfYaml(root, ""));
    const logs: string[] = [];
    wolf = await startWolf({ configPath: join(root, "wolf.yaml"), env: { WOLFPACK_MODELS_FILE: models }, home: root, models: scripted.models, log: (l) => logs.push(l) });
    expect(logs.join("\n")).toMatch(/warning: Extension wolfpack-memory: Not found/);
  });
});
