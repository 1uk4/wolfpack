/** The /v1 contract suite against WolfServer over a ScriptedEngine (deterministic, no model, no network). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { runContractSuite } from "@wolfpack/protocol/contract";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";

const den = mkdtempSync(join(tmpdir(), "wolfd-contract-"));
const server = new WolfServer({ name: "scripted", den, conversation: new ScriptedEngine({ delayMs: 15 }) });
let url = "";
beforeAll(async () => {
  await server.attach();
  url = await server.listen();
});
afterAll(async () => {
  await server.close();
  rmSync(den, { recursive: true, force: true });
});

runContractSuite(() => url);
