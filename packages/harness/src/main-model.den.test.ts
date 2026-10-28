/**
 * Boots the real pi-durable Harness against a den copy that ALREADY holds a root conversation stored with provider
 * "anthropic" (a wolf that ran on the API key before the switch), then starts it on the bridge.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { selectMainModel, startRoot } from "./main-model.js";

const MODEL = "claude-sonnet-5-5";
const ctx = BACKGROUND_CONTEXT;
let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const bridgeProvider = () => {
  const models = [{ id: MODEL, name: MODEL, api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }];
  const stream = () => { throw new Error("no turns in this test"); };
  const base = createProvider({ id: "claude-bridge", auth: { apiKey: { name: "x", check: async () => ({ source: "t" }), resolve: async () => ({ auth: { apiKey: "x" }, source: "t" }) } }, models, api: { stream, streamSimple: stream } } as any);
  return Object.assign(base, { shutdown: () => {}, release: () => 0, liveQueries: 0 }) as never;
};

async function openHarness(models: any) {
  const storage = await openNodeSqliteStorage(path.join(dir, "session.sqlite"));
  return Harness.open(storage, { models, registry: createRegistry(), env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? dir }) } as never, ctx);
}

describe("existing den with a root stored on provider anthropic", () => {
  async function seedDen() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fixture-"));
    const apiModels = createModels();
    apiModels.setProvider(anthropicProvider());
    const h = await openHarness(apiModels);
    const root = await h.root(ctx, { agent: { model: { provider: "anthropic", modelId: MODEL }, cwd: dir } } as never);
    const id = root.id;
    await h.close(ctx);
    return id;
  }

  it("starts on the bridge: the stored root is moved onto claude-bridge and the old ref still resolves", async () => {
    const id = await seedDen();
    const choice = await selectMainModel({ cwd: dir, table: { transport: "subscription", tiers: { main: { model: MODEL } } } as never, env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, loadSdkQuery: async () => () => {}, createProvider: bridgeProvider });
    expect(choice.via).toBe("bridge");
    const h = await openHarness(choice.models as never);
    const root = await startRoot(choice, (a) => h.root(ctx, { agent: { model: a.model, cwd: dir } } as never), undefined, ctx, { warn: () => {} });
    expect(root.id).toBe(id);
    expect(choice.via).toBe("bridge");
    // Anything still holding the stored ref (children, in-flight checkpoints, resume) resolves through the registry.
    expect(choice.models.getModel("anthropic", MODEL)?.provider).toBe("claude-bridge");
    expect(() => h.resume()).not.toThrow();
    await h.close(ctx);
  });

  it("a bridge that cannot serve the model falls back to the API key and the same root keeps working", async () => {
    const id = await seedDen();
    const choice = await selectMainModel({ cwd: dir, table: { transport: "subscription", tiers: { main: { model: MODEL } } } as never, env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, loadSdkQuery: async () => () => {}, createProvider: bridgeProvider });
    const h = await openHarness(choice.models as never);
    // Simulate the engine refusing the bridge model on configure.
    const root = await startRoot(choice, async (a) => {
      const r = await h.root(ctx, { agent: { model: a.model, cwd: dir } } as never);
      return new Proxy(r, { get: (t, p) => (p === "configure" ? async (o: any, c: any) => { if (o.model.provider === "claude-bridge") throw new Error("model not found"); return (t as any).configure(o, c); } : (t as any)[p]) });
    }, undefined, ctx, { warn: () => {} });
    expect(root.id).toBe(id);
    expect(choice.via).toBe("api");
    expect(choice.model.provider).toBe("anthropic");
    expect(choice.models.getModel("anthropic", MODEL)?.provider).toBe("anthropic");
    await h.close(ctx);
  });
});
