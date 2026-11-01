// wolfd with a deterministic scripted model (pi-ai faux provider), for the tracer. Same real startWolf as bin/wolfd.ts
// (real sqlite, pi-durable, /v1 server); only the model's replies are canned. Accepts the args workerd appends:
//   stub-wolfd.mjs --config <wolf.yaml> (--socket <path> | --port N)
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.WOLFPACK_ROOT ?? "/opt/wolfpack";
const { startWolf } = await import(`${root}/packages/harness/dist/wolfd/index.js`);
const { createScriptedModel, fauxAssistantMessage } = await import(`${root}/packages/harness/dist/wolfd/scripted-model.js`);

const { values } = parseArgs({ options: { config: { type: "string" }, socket: { type: "string" }, port: { type: "string" } } });
if (!values.config) { console.error("usage: stub-wolfd.mjs --config wolf.yaml [--socket p | --port N]"); process.exit(2); }

const reply = process.env.TRACER_REPLY ?? "tracer-pong";
const scripted = createScriptedModel(Array.from({ length: 200 }, () => fauxAssistantMessage(reply)));
const tier = { model: scripted.modelId, modelSource: "default", provider: scripted.provider, piModel: `${scripted.provider}/${scripted.modelId}` };
const modelsFile = join(dirname(values.config), "models.json");
writeFileSync(modelsFile, JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }));

const wolf = await startWolf({
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
