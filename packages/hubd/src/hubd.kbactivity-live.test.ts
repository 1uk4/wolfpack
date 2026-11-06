/** The live path end to end: a real curator tick, GET /v1/kb/activity sweep.current and the sweep_progress hub event while an item is in progress. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { KbActivityResponseSchema } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer } from "./server.js";
import { contributionsDir } from "./layout.js";
import { OP, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  aborts.splice(0).forEach((a) => a.abort());
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
    if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
    if (step === "matchSubject") return schema.parse({ match: "new", reason: "different" });
    return schema.parse({ title: "Topic", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;
const embedder = { embed: async () => [1, 0, 0], shouldCompact: () => false, compact: () => 0 } as any;

async function until(cond: () => unknown, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("GET /v1/kb/activity while the curator works", () => {
  it("shows sweep.current for the item in progress, emits sweep_progress, and drops it when the sweep ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kblive-"));
    tmp.push(dir);
    seedTokens(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCall = new Promise<void>((r) => (entered = r));
    const gated = { ...engine, call: async (...a: [string, any]) => { entered(); await gate; return (engine as any).call(...a); } } as unknown as Engine;
    const hub = await createHubServer({ dataDir: dir, port: 0, curator: { enabled: true, pollMs: 0, createEngine: () => gated, getEmbedder: () => embedder } });
    servers.push(hub);
    const post = (path: string, body: unknown) => fetch(hub.url + path, { method: "POST", headers: { ...OP, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/v1/registry/domains", { name: "wp" });
    await post("/v1/registry/hosts", { name: "box" });
    await post("/v1/registry/wolves", { name: "alpha", host: "box", domains: ["wp"] });

    let buf = "";
    const ctl = new AbortController();
    aborts.push(ctl);
    void fetch(hub.url + "/v1/events", { headers: OP, signal: ctl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
      }
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));

    const lane = contributionsDir(dir, "alpha");
    mkdirSync(lane, { recursive: true });
    const body = "# Title 1\n\nbody 1";
    writeFileSync(join(lane, "topic-1-aaaaaaaaa1.md"), `---\nfrom: alpha\nden_topic_id: topic-1\ncontent_hash: ${contentHash(body)}\nprev_hash: null\ndomain_hint: wp\n---\n\n${body}\n`);

    const activity = async () => KbActivityResponseSchema.parse(await (await fetch(hub.url + "/v1/kb/activity", { headers: OP })).json());
    expect((await activity()).sweep).toEqual({ running: false });

    const tick = hub.runCuratorOnce();
    await inCall;
    const mid = (await activity()).sweep;
    expect(mid).toMatchObject({ running: true, current: { from: "alpha", denTopicId: "topic-1" } });
    await until(() => buf.includes('"type":"sweep_progress"'), "sweep_progress event");
    expect(buf).toMatch(/"type":"sweep_progress"[^\n]*"denTopicId":"topic-1"/);

    release();
    await tick;
    await until(() => buf.includes('"type":"sweep_finished"'), "sweep_finished");
    const end = (await activity()).sweep;
    expect(end?.running).toBe(false);
    expect(end?.current).toBeUndefined();
  }, 30_000);
});
