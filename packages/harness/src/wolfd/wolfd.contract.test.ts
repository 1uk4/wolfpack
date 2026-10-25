/** The /v1 contract suite against WolfServer over a ScriptedEngine (deterministic, no model, no network). */
import { afterAll, beforeAll } from "vitest";
import { runContractSuite } from "@wolfpack/protocol/contract";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const server = new WolfServer({ name: "scripted", conversation: new ScriptedEngine({ delayMs: 15 }) });
let url = "";
beforeAll(async () => {
  await server.attach();
  url = await server.listen();
});
afterAll(() => server.close());

runContractSuite(() => url);
