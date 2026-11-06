// wolfd with a deterministic scripted model (pi-ai faux provider), for the tracer. Same real startWolf as bin/wolfd.ts
// (real sqlite, pi-durable, /v1 server); only the model's replies are canned. Accepts the args workerd appends:
//   stub-wolfd.mjs --config <wolf.yaml> (--socket <path> | --port N)
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.WOLFPACK_ROOT ?? "/opt/wolfpack";
const { startWolf } = await import(`${root}/packages/harness/dist/wolfd/index.js`);
const { createScriptedModel, fauxAssistantMessage, fauxText, fauxToolCall } = await import(`${root}/packages/harness/dist/wolfd/scripted-model.js`);

const { values } = parseArgs({ options: { config: { type: "string" }, socket: { type: "string" }, port: { type: "string" } } });
if (!values.config) { console.error("usage: stub-wolfd.mjs --config wolf.yaml [--socket p | --port N]"); process.exit(2); }

const reply = process.env.TRACER_REPLY ?? "tracer-pong";
// TRACER_SLOW_MS (durability seam): every turn is two model requests, so a kill -9 can land between/inside them. Request 1 waits that long, then
// asks for a tool ("write"); request 2 (the context ends in a tool result) answers `reply`. Decided from the context, not a call counter,
// so a restarted process that re-runs the turn from the store behaves identically.
const slowMs = Number(process.env.TRACER_SLOW_MS ?? 0);
const step = slowMs > 0
  ? async (ctx) => {
      const last = ctx.messages[ctx.messages.length - 1];
      if (last?.role === "toolResult") return fauxAssistantMessage(reply);
      await new Promise((r) => setTimeout(r, slowMs));
      return fauxAssistantMessage([fauxText("working"), fauxToolCall("write", { path: "tracer-durable.txt", content: "x" })], { stopReason: "toolUse" });
    }
  : () => fauxAssistantMessage(reply);
const scripted = createScriptedModel(Array.from({ length: 200 }, () => step));
const tier = { model: scripted.modelId, modelSource: "default", provider: scripted.provider, piModel: `${scripted.provider}/${scripted.modelId}` };
const modelsFile = join(dirname(values.config), "models.json");
writeFileSync(modelsFile, JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }));

// TRACER_KB=1 (kb mode): the REAL memory + tasks extensions (bundled sources, see kb-ext-entry.ts) driven by a scripted memory Engine, so the
// memory path observe -> consolidate -> promote(distill) and the graduation preview run without an LLM. Everything else (hub KB mirror,
// contribution feeder, Work API client, routes) is the production code in wolfd.
let extraExtensions;
if (process.env.TRACER_KB === "1") {
  const { createMemoryExtension, createTasksExtension, adaptToDurable } = await import(`${root}/kb-ext.mjs`);
  const OBS = "Session lookups are cached for five minutes because the profile endpoint is the hot path (tracer-kb-observation).";
  const engine = {
    call: async (stepName, schema) => {
      if (stepName === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: OBS }] });
      if (stepName === "consolidate") return schema.parse({ actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }] });
      if (stepName === "distill") return schema.parse({ contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached.", body: "## How\n\nSession lookups are cached for five minutes (tracer-kb-contribution).\n\n## History\n\n- 2026-10-28: added caching" }] });
      if (stepName === "workRecord") return schema.parse({ decisions: [], changes: [{ text: "Cached the lookups", from: [] }], findings: [], problems: [] });
      throw new Error(`tracer kb engine: unexpected step ${stepName}`);
    },
    usage: { summarize: () => ({}) },
  };
  extraExtensions = ({ config, den, env }) => {
    const c = { wolfDen: den, wolfName: config.identity.name, domains: config.identity.domains, wolfConfig: {}, env };
    const tasks = createTasksExtension({ autoShip: true, engine: () => engine }, c);
    const memory = createMemoryExtension({ ...config.memory, engine }, c);
    const o = { wolfDen: den, wolfName: config.identity.name };
    return [adaptToDurable(memory, o), adaptToDurable(tasks, o)];
  };
}

const wolf = await startWolf({
  ...(extraExtensions ? { extraExtensions } : {}),
  configPath: values.config,
  env: { ...process.env, WOLFPACK_MODELS_FILE: modelsFile },
  models: scripted.models,
  socket: values.socket,
  port: values.socket ? undefined : values.port === undefined ? undefined : Number(values.port),
  log: (l) => console.error(`[wolfd] ${l}`),
});
console.log(`wolfd: ${wolf.config.identity.name} serving ${wolf.url}`);
const stop = () => wolf.close().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
