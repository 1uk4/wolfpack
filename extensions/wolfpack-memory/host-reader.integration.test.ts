/**
 * createWolfHarness opens pi-durable's Harness directly (not via openWolfEngine). This boots the same way (Harness.open +
 * attachConversationReader + adapted memory extension) and proves a turn is observed, and that close detaches.
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, Harness } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeExecutionEnv } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/env/node.js";
import { openNodeSqliteStorage } from "../../packages/harness/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { afterEach, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import createMemoryExtension from "./unified.js";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { attachConversationReader, conversationReaderFor } from "../../packages/harness/src/engine/conversation-reader.js";
import { ENGINE_CONTEXT as ctx } from "../../packages/harness/src/engine/index.js";
import { createScriptedModel, fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

it("a Harness opened the createWolfHarness way (reader attached) observes a turn; close detaches", async () => {
  dir = mkdtempSync(join(tmpdir(), "host-reader-"));
  const prompts: string[] = [];
  const engine = {
    call: async (_s: string, schema: { parse: (v: unknown) => unknown }, a: { prompt: string }) => {
      prompts.push(a.prompt);
      return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: "Cache lookups" }] });
    },
  } as unknown as Engine;
  const sm = createScriptedModel([fauxAssistantMessage("HOSTREPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
  const registry = createRegistry();
  registry.install(adaptToDurable(createMemoryExtension({ live: true, engine }, { wolfDen: dir, wolfName: "w", domains: ["wolfpack"], wolfConfig: {}, env: {} }), { wolfDen: dir, wolfName: "w" }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) }, ctx);
  const detach = attachConversationReader(harness, dir, { hostConsolidationTimer: true });
  expect(conversationReaderFor(dir)).toBeDefined();
  const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
  harness.resume();
  await root.submit({ type: "input", content: "HOSTUSER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
  await root.waitForIdle(ctx);
  const wm = join(dir, ".memory", "watermarks", "1.json");
  for (let i = 0; i < 100 && !existsSync(wm); i++) await new Promise((r) => setTimeout(r, 30));
  expect(existsSync(wm)).toBe(true);
  expect(prompts.join("\n")).toContain("HOSTUSER");
  expect(readFileSync(join(dir, ".memory/pool/observations.jsonl"), "utf8")).toContain("Cache lookups");
  detach();
  expect(conversationReaderFor(dir)).toBeUndefined();
  await harness.close(ctx);
});

it("(f) the createWolfHarness path tags per observation with domain context, and stamps untagged ones with defaultDomain", async () => {
  dir = mkdtempSync(join(tmpdir(), "host-domain-"));
  const kb = join(dir, "kb");
  mkdirSync(kb);
  writeFileSync(join(kb, "domains.yaml"), "domains:\n  billing:\n    description: Invoices and payments\n  devtools:\n    description: Build tooling\n");
  const systems: string[] = [];
  const engine = {
    call: async (_s: string, schema: { parse: (v: unknown) => unknown }, a: { system: string; prompt: string }) => {
      systems.push(a.system);
      return schema.parse({
        observations: [
          { timestamp: "2026-10-25 10:00", content: "Tagged one", domain: "billing" },
          { timestamp: "2026-10-25 10:01", content: "Untagged one" },
        ],
      });
    },
  } as unknown as Engine;
  const sm = createScriptedModel([fauxAssistantMessage("HOSTREPLY we decided to cache the session lookups for five minutes because of the hot path.")]);
  const registry = createRegistry();
  registry.install(adaptToDurable(
    createMemoryExtension({ live: true, engine, defaultDomain: "devtools" }, { wolfDen: dir, wolfName: "w", domains: ["billing", "devtools"], wolfConfig: {}, env: { KB_BASE: kb } }),
    { wolfDen: dir, wolfName: "w" },
  ));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models: sm.models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) }, ctx);
  const detach = attachConversationReader(harness, dir, { hostConsolidationTimer: true });
  const root = await harness.root(ctx, { agent: { model: { provider: sm.provider, modelId: sm.modelId } } });
  harness.resume();
  await root.submit({ type: "input", content: "HOSTUSER please remember the caching decision we made today.", whenBusy: "reject" }, ctx);
  await root.waitForIdle(ctx);
  const wm = join(dir, ".memory", "watermarks", "1.json");
  for (let i = 0; i < 100 && !existsSync(wm); i++) await new Promise((r) => setTimeout(r, 30));
  const obs = readFileSync(join(dir, ".memory/pool/observations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(systems[0]).toContain("Domains this wolf subscribes to:");
  expect(systems[0]).toContain("billing: Invoices and payments");
  expect(obs.map((o) => [o.content, o.domain])).toEqual([["Tagged one", "billing"], ["Untagged one", "devtools"]]);
  detach();
  await harness.close(ctx);
});
