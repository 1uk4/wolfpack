/** Per-thread composer settings over /v1: tier applied through configure, persisted across restarts, auto-ship mirrored for the extension. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readThreadAutoShip } from "@wolfpack/memory";
import { ScriptedEngine } from "./scripted-engine.js";
import { WolfServer } from "./server.js";
import { startTestWolf, type TestWolf } from "./test-wolf.js";

const dens: string[] = [];
const servers: WolfServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dens.splice(0)) rmSync(d, { recursive: true, force: true });
});

const put = (url: string, id: string, body: unknown) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}/settings`, { method: "PUT", body: JSON.stringify(body) });
const get = (url: string, id: string) => fetch(`${url}/v1/threads/${encodeURIComponent(id)}/settings`);
const modelOf = (tier: string) => ({ provider: "p", modelId: `m-${tier}` });

function harness(den: string) {
  const engines = new Map<string, ScriptedEngine>();
  const home = new ScriptedEngine({ delayMs: 1, id: "900" });
  let n = 0;
  const conversations = {
    create: async () => {
      const e = new ScriptedEngine({ delayMs: 1, id: `${100 + ++n}` });
      engines.set(e.id, e);
      return e;
    },
    get: async (id: string) => engines.get(id),
    setTier: async (conv: { configure(o: { model: { provider: string; modelId: string } }): Promise<void> }, tier: string) => conv.configure({ model: modelOf(tier) }),
  };
  const boot = async (homeEngine = home) => {
    const s = new WolfServer({ name: "w", den, conversation: homeEngine, conversations, tierModels: { main: "m-main", smart: "m-smart", fast: "m-fast" } });
    servers.push(s);
    await s.attach();
    return { s, url: await s.listen() };
  };
  return { engines, home, boot };
}

const newDen = () => {
  const d = mkdtempSync(join(tmpdir(), "wolfd-settings-"));
  dens.push(d);
  return d;
};
const feature = (url: string) => fetch(`${url}/v1/wolves/w/threads`, { method: "POST", body: JSON.stringify({ kind: "feature", workItemId: "work-wolfpack-feat0001" }) }).then((r) => r.json());

describe("thread settings", () => {
  it("defaults to main / auto-ship off, with the model each tier resolves to", async () => {
    const h = harness(newDen());
    const { url } = await h.boot();
    expect(await (await get(url, "w/home")).json()).toEqual({ tier: "main", autoShip: false, models: { main: "m-main", smart: "m-smart", fast: "m-fast" } });
    expect((await (await fetch(`${url}/v1/threads/w%2Fhome`)).json()).settings).toEqual({ tier: "main", autoShip: false });
  });

  it("a tier change configures the conversation with that tier's model (home and feature), autoShip alone does not", async () => {
    const h = harness(newDen());
    const { url } = await h.boot();
    const f = await feature(url);
    expect((await put(url, "w/home", { tier: "smart" })).status).toBe(200);
    expect(h.home.configured).toEqual([{ model: modelOf("smart") }]);
    expect((await put(url, f.id, { tier: "fast", autoShip: true })).status).toBe(200);
    expect(h.engines.get("101")!.configured).toEqual([{ model: modelOf("fast") }]);
    await put(url, f.id, { autoShip: false });
    expect(h.engines.get("101")!.configured).toHaveLength(1);
    // the list and the detail carry the settings
    const list = await (await fetch(`${url}/v1/wolves/w/threads`)).json();
    expect(list.threads.map((t: { settings: unknown }) => t.settings)).toEqual([{ tier: "smart", autoShip: false }, { tier: "fast", autoShip: false }]);
  });

  it("rejects bad bodies and unknown threads", async () => {
    const { boot } = harness(newDen());
    const { url } = await boot();
    expect((await put(url, "w/home", {})).status).toBe(400);
    expect((await put(url, "w/home", { tier: "huge" })).status).toBe(400);
    expect((await put(url, "w/nope", { tier: "fast" })).status).toBe(404);
    expect((await get(url, "w/nope")).status).toBe(404);
  });

  it("a tier change while a turn runs applies when the turn ends", async () => {
    const den = newDen();
    const h = harness(den);
    const slow = new ScriptedEngine({ delayMs: 80, id: "900" });
    const { url } = await h.boot(slow);
    await fetch(`${url}/v1/threads/w%2Fhome/submit`, { method: "POST", body: JSON.stringify({ input: "go", whenBusy: "reject" }) });
    expect((await put(url, "w/home", { tier: "fast" })).status).toBe(200);
    expect(slow.configured).toEqual([]); // the running turn keeps its model
    expect((await (await get(url, "w/home")).json()).tier).toBe("fast"); // the choice is recorded at once
    await vi.waitFor(() => expect(slow.configured).toEqual([{ model: modelOf("fast") }]), { timeout: 5000 });
  });

  it("persists across a restart: registry/home file, and the extension's per-conversation auto-ship flag", async () => {
    const den = newDen();
    const h = harness(den);
    const first = await h.boot();
    const f = await feature(first.url);
    await put(first.url, f.id, { tier: "smart", autoShip: true });
    await put(first.url, "w/home", { tier: "fast", autoShip: true });
    expect(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads[0]).toMatchObject({ tier: "smart", autoShip: true });
    expect(readThreadAutoShip(den, 101)).toBe(true);
    expect(readThreadAutoShip(den, 900)).toBe(true);
    await first.s.close();

    const second = await h.boot(new ScriptedEngine({ delayMs: 1, id: "900" }));
    expect(await (await get(second.url, f.id)).json()).toMatchObject({ tier: "smart", autoShip: true });
    expect(await (await get(second.url, "w/home")).json()).toMatchObject({ tier: "fast", autoShip: true });
    // turning it off flips the flag the extension reads, for that conversation only
    await put(second.url, f.id, { autoShip: false });
    expect(readThreadAutoShip(den, 101)).toBe(false);
    expect(readThreadAutoShip(den, 900)).toBe(true);
  });
});

describe("thread settings on a real wolf", () => {
  let tw: TestWolf | undefined;
  afterEach(async () => {
    await tw?.stop();
    tw = undefined;
  });

  it("a restarted wolf boots each conversation on its saved tier's model", async () => {
    const yaml = "tiers:\n  smart:\n    model: smart-model-x\n";
    tw = await startTestWolf({ script: [], yaml });
    const root = tw.root;
    const first = tw;
    const feat = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: "work-wolfpack-feat0001" });
    expect(await tw.client.putThreadSettings!(feat.id, { tier: "smart", autoShip: true })).toMatchObject({ tier: "smart", autoShip: true, models: { main: expect.any(String), smart: "smart-model-x" } });
    await tw.client.putThreadSettings!(tw.home, { tier: "smart" });
    const agentModel = async (conv: { watch(): Promise<{ snapshot: { agent: { model?: { modelId?: string } } }; stop(): Promise<void> }> }) => {
      const w = await conv.watch();
      const id = w.snapshot.agent.model?.modelId;
      await w.stop();
      return id;
    };
    expect(await agentModel(tw.wolf.conversation)).toBe("smart-model-x");
    await first.wolf.close();
    tw = undefined;

    // restart over the same root: home and the feature thread come back on smart without any request
    const again = await startTestWolf({ script: [], yaml, root });
    try {
      expect(await agentModel(again.wolf.conversation)).toBe("smart-model-x");
      expect(await again.client.getThreadSettings!(feat.id)).toMatchObject({ tier: "smart", autoShip: true });
      const saved = JSON.parse(readFileSync(join(root, "den", "wolfd", "threads.json"), "utf8")).threads[0] as { conversationId: string };
      const featConv = await again.wolf.engine.conversations.get(saved.conversationId);
      expect(await agentModel(featConv!)).toBe("smart-model-x");
    } finally {
      await again.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
