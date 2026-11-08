/** The hub curator: the KB sweep on the contributions lane, committed through commitKb, receipts relayed over the link. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Engine } from "@wolfpack/engine";
import { LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { readLedger, leaseFile } from "@wolfpack/kb/librarian";
import { hostname } from "node:os";
import { utimesSync } from "node:fs";
import { createHubSweepWriter, SYSTEM_ACTOR } from "./curator.js";
import { createTokenStore } from "./auth.js";
import { curatorFromEnv } from "./cli.js";
import { createHubServer, type HubServer, type HubOptions } from "./server.js";
import { contributionsDir, contributionsRoot } from "./layout.js";
import { OP, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const w of sockets.splice(0)) w.terminate();
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
const curatorOpts = (extra: object = {}) => ({ enabled: true, pollMs: 0, createEngine: () => engine, getEmbedder: () => embedder, ...extra });

async function start(extra: Partial<HubOptions> = {}, dir = mkdtempSync(join(tmpdir(), "hubd-curator-"))) {
  if (!tmp.includes(dir)) tmp.push(dir);
  seedTokens(dir);
  const hub = await createHubServer({ dataDir: dir, port: 0, receiptPollMs: 40, ...extra });
  servers.push(hub);
  const post = (path: string, body: unknown) => fetch(hub.url + path, { method: "POST", headers: { ...OP, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await post("/v1/registry/domains", { name: "wp" });
  await post("/v1/registry/hosts", { name: "box" });
  await post("/v1/registry/wolves", { name: "alpha", host: "box", domains: ["wp"] });
  return { hub, dir };
}

const contribution = (n = 1) => ({ from: "alpha", denTopicId: `topic-${n}`, change: "create", contentHash: contentHash(`# Title ${n}\n\nbody ${n}`), prevHash: null, domainHint: "wp", summary: "A summary", submitted: "2026-10-01 12:00", body: `# Title ${n}\n\nbody ${n}`, origin: "crawl", sourcePath: "/s" });

class Conn {
  frames: LinkFrame[] = [];
  constructor(readonly ws: WebSocket) {
    sockets.push(ws);
    ws.on("message", (d) => {
      const p = parseLinkFrame(d.toString());
      if (p.ok) this.frames.push(p.frame);
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
  frame<T extends LinkFrame["t"]>(t: T) {
    return this.frames.find((f) => f.t === t) as Extract<LinkFrame, { t: T }> | undefined;
  }
}
async function until(cond: () => unknown, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function connect(hub: HubServer, dir: string): Promise<Conn> {
  const store = createTokenStore(dir);
  const { token } = store.redeem(store.mintPairingCode({ kind: "worker", hostId: "box" }).code, "t", "worker", "box");
  const ws = new WebSocket(hub.url.replace("http", "ws") + "/v1/link", { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
  const c = new Conn(ws);
  c.send({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: "box", laptop: false, wolves: [{ name: "alpha", domains: ["wp"] }], kbRevisions: {} });
  await until(() => c.frame("welcome"), "welcome");
  return c;
}
/** Follow GET /v1/events; `text()` is everything received so far. */
function followEvents(hub: HubServer) {
  let buf = "";
  const ctl = new AbortController();
  void fetch(hub.url + "/v1/events", { headers: OP, signal: ctl.signal }).then(async (r) => {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
    }
  }).catch(() => undefined);
  afterEachStops.push(() => ctl.abort());
  return { text: () => buf, types: () => [...buf.matchAll(/"type":"([a-z._]+)"/g)].map((m) => m[1]) };
}
const afterEachStops: Array<() => void> = [];
afterEach(() => afterEachStops.splice(0).forEach((f) => f()));

const lane = (dir: string) => contributionsDir(dir, "alpha");
const entryFiles = (dir: string) => {
  const d = join(dir, "kb", "base", "domains", "wp", "entries");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
};

describe("hub curator", () => {
  it("a contribution pushed over the link becomes a committed entry, a receipt, and events", async () => {
    const { hub, dir } = await start({ curator: curatorOpts() });
    const events = followEvents(hub);
    await new Promise((r) => setTimeout(r, 100));
    const conn = await connect(hub, dir);
    conn.send({ t: "contribute", id: "c1", wolf: "alpha", contribution: contribution() });
    await until(() => conn.frame("contribute.ack"), "contribute.ack");
    expect(conn.frame("contribute.ack")).toMatchObject({ status: "accepted" });
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    const run = await hub.runCuratorOnce();
    expect(run).toMatchObject({ outcome: "ran", processed: 1, created: 1 });
    expect(run!.error).toBeUndefined();

    // the entry, through commitKb: file, digest, INDEX, exactly one entry_written
    const files = entryFiles(dir);
    expect(files).toHaveLength(1);
    const id = files[0].slice(0, -3);
    expect(id).toMatch(/^kb-wp-[0-9A-Za-z]{7}$/);
    const domainDir = join(dir, "kb", "base", "domains", "wp");
    expect(readFileSync(join(domainDir, "INDEX.md"), "utf8")).toContain(id);
    expect(readFileSync(join(domainDir, "_digest.json"), "utf8")).toContain(id);
    expect(readFileSync(join(domainDir, "_registry.md"), "utf8")).toContain(id);
    const written = readLedger(hub.roots).filter((e) => (e as { t: string }).t === "entry_written");
    expect(written).toHaveLength(1);
    // one decision event per contribution, next to the contribution event, carrying the routing; sweep_item carries the same summary
    const decisions = readLedger(hub.roots).filter((e) => (e as { t: string }).t === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: "create", entryId: id, routing: { route: "new", target: id } });
    // the lane item moved, the receipt was written
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(readdirSync(join(lane(dir), "_processed"))).toHaveLength(1);
    const receipts = readdirSync(join(dir, "kb", "ops", "receipts", "alpha"));
    expect(receipts).toHaveLength(1);
    expect(readFileSync(join(dir, "kb", "ops", "receipts", "alpha", receipts[0]), "utf8")).toContain(`outcome: create`);
    // the events
    await until(() => events.types().includes("sweep_finished"), "sweep_finished");
    const types = events.types();
    expect(types.filter((t) => t === "sweep_started")).toHaveLength(1);
    expect(types.filter((t) => t === "sweep_item")).toHaveLength(1);
    expect(types.filter((t) => t === "sweep_finished")).toHaveLength(1);
    expect(types).toContain("kb.changed");
    expect(events.text()).toContain(id);
    expect(events.text()).toContain('"decision":{"outcome":"create"');
    // the receipt is relayed back over the link
    await until(() => conn.frame("receipt"), "receipt frame");
    expect(conn.frame("receipt")).toMatchObject({ wolf: "alpha", content: expect.stringContaining("outcome: create") });
  }, 30_000);

  it("an idle lane does nothing", async () => {
    const { hub, dir } = await start({ curator: curatorOpts() });
    const events = followEvents(hub);
    expect(await hub.runCuratorOnce()).toMatchObject({ outcome: "idle", processed: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(events.types().filter((t) => t.startsWith("sweep_"))).toEqual([]);
    expect(entryFiles(dir)).toEqual([]);
  });

  it("is off by default: no lease, no tick", async () => {
    const { hub, dir } = await start();
    mkdirSync(lane(dir), { recursive: true });
    writeFileSync(join(lane(dir), "t-aaaaaaaaaa.md"), "---\nfrom: alpha\nden_topic_id: t\ncontent_hash: c0de\nprev_hash: null\ndomain_hint: wp\n---\n\n# T\n\nbody\n");
    expect(await hub.runCuratorOnce()).toBeUndefined();
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect(existsSync(leaseFile(contributionsRoot(dir)))).toBe(false);
    expect(curatorFromEnv({})).toEqual({ enabled: false });
    expect(curatorFromEnv({ HUBD_CURATOR: "1", HUBD_CURATOR_POLL_MS: "0" })).toMatchObject({ enabled: true, pollMs: 0 });
    expect(curatorFromEnv({ HUBD_CURATOR: "1" })).toMatchObject({ pollMs: 60000 });
  });

  it("holds the hub lease while on and releases it on close", async () => {
    const { hub, dir } = await start({ curator: curatorOpts() });
    expect(JSON.parse(readFileSync(leaseFile(contributionsRoot(dir)), "utf8")).owner).toBe("hub");
    await hub.close();
    servers.pop();
    expect(existsSync(leaseFile(contributionsRoot(dir)))).toBe(false);
  });

  it("refuses to start while a fresh wolf lease exists, and with a foreign lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-curator-"));
    tmp.push(dir);
    seedTokens(dir);
    mkdirSync(join(dir, "kb", "ops", "inbox"), { recursive: true });
    writeFileSync(join(dir, "kb", "ops", "inbox", ".sweep-lease"), JSON.stringify({ owner: "wolf", pid: process.pid, host: require("node:os").hostname(), at: new Date().toISOString() }));
    await expect(createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() })).rejects.toThrow(/wolf-side sweep holds the sweep lease/);
    // the failed start released the KB writer lock: a plain hub starts on the same dir
    const ok = await createHubServer({ dataDir: dir, port: 0 });
    servers.push(ok);
    await ok.close();
    servers.pop();
    const dir2 = mkdtempSync(join(tmpdir(), "hubd-curator-"));
    tmp.push(dir2);
    seedTokens(dir2);
    await expect(createHubServer({ dataDir: dir2, port: 0, inboxRoot: join(dir2, "elsewhere"), curator: curatorOpts() })).rejects.toThrow(/own contributions lane/);
    await expect(createHubServer({ dataDir: dir2, port: 0, receiptsRoot: join(dir2, "elsewhere"), curator: curatorOpts() })).rejects.toThrow(/own receipts lane/);
  });

  it("a racing commit is a conflict: the item stays in the lane, no receipt, sweep_finished carries the error", async () => {
    let raced = false;
    const { hub, dir } = await start({
      curator: curatorOpts({
        afterEntryRead: (id: string) => {
          if (raced) return;
          raced = true;
          const d = join(dir, "kb", "base", "domains", "wp", "entries");
          mkdirSync(d, { recursive: true });
          writeFileSync(join(d, `${id}.md`), "a racing writer\n"); // appears after the compare-and-set was read
        },
      }),
    });
    const events = followEvents(hub);
    await new Promise((r) => setTimeout(r, 100));
    mkdirSync(lane(dir), { recursive: true });
    const c = contribution(2);
    writeFileSync(join(lane(dir), "topic-2-aaaaaaaaaa.md"), `---\nfrom: alpha\nden_topic_id: ${c.denTopicId}\ncontent_hash: ${c.contentHash}\nprev_hash: null\ndomain_hint: wp\n---\n\n${c.body}\n`);
    const run = await hub.runCuratorOnce();
    expect(run!.error).toMatch(/stale write|conflict/);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect(existsSync(join(lane(dir), "_processed"))).toBe(false);
    expect(existsSync(join(dir, "kb", "ops", "receipts", "alpha"))).toBe(false);
    await until(() => events.types().includes("sweep_finished"), "sweep_finished");
    expect(events.types().filter((t) => t === "sweep_started")).toHaveLength(1);
    expect(events.text()).toMatch(/"type":"sweep_finished"[^\n]*"error":"[^"]*(stale write|conflict)/);
    expect(readLedger(hub.roots).filter((e) => (e as { t: string }).t === "entry_written")).toHaveLength(0);
  }, 30_000);
});

const drop = (dir: string, n: number) => {
  mkdirSync(lane(dir), { recursive: true });
  const c = contribution(n);
  writeFileSync(join(lane(dir), `topic-${n}-aaaaaaaaa${n}.md`), `---\nfrom: alpha\nden_topic_id: ${c.denTopicId}\ncontent_hash: ${c.contentHash}\nprev_hash: null\ndomain_hint: wp\n---\n\n${c.body}\n`);
};
const ledgerCount = (hub: HubServer, t: string) => readLedger(hub.roots).filter((e) => (e as { t: string }).t === t).length;
const wolfLease = (dir: string, o: object = {}) => {
  mkdirSync(join(dir, "kb", "ops", "inbox"), { recursive: true });
  writeFileSync(join(dir, "kb", "ops", "inbox", ".sweep-lease"), JSON.stringify({ owner: "wolf", pid: process.pid, host: hostname(), at: new Date().toISOString(), ...o }));
};
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "hubd-curator-")); tmp.push(d); seedTokens(d); return d; };

describe("hub curator: wolf lease refusals", () => {
  it("refuses a live-pid wolf lease (own pid and another live pid), accepts a stale one and a dead-pid one", async () => {
    const dir = freshDir();
    wolfLease(dir, { pid: process.ppid }); // another live process on this host
    await expect(createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() })).rejects.toThrow(/wolf-side sweep holds the sweep lease/);
    wolfLease(dir, { pid: process.pid });
    await expect(createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() })).rejects.toThrow(/wolf-side sweep holds the sweep lease/);
    // a lease from another host cannot be pid-checked: held until it is stale by age
    wolfLease(dir, { pid: 1, host: "elsewhere" });
    await expect(createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() })).rejects.toThrow(/wolf-side sweep holds the sweep lease/);
    const f = join(dir, "kb", "ops", "inbox", ".sweep-lease");
    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(f, old, old); // stale by age
    const a = await createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() });
    servers.push(a);
    await a.close();
    servers.pop();
    wolfLease(dir, { pid: 2147483000 }); // dead pid on this host: stale at once
    const b = await createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() });
    servers.push(b);
  }, 30_000);

  it("a wolf lease that appears while the hub runs skips the tick", async () => {
    const { hub, dir } = await start({ curator: curatorOpts() });
    drop(dir, 1);
    wolfLease(dir);
    expect(await hub.runCuratorOnce()).toMatchObject({ outcome: "skipped" });
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });
});

describe("hub curator: failures", () => {
  const pairs = (events: ReturnType<typeof followEvents>) => ({ s: events.types().filter((t) => t === "sweep_started").length, f: events.types().filter((t) => t === "sweep_finished").length });

  it("a writeReceipt failure after the commit: the entry stays, the item stays queued, started/finished are paired", async () => {
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, writeReceipt: () => { throw new Error("disk full"); } }) }) });
    const events = followEvents(hub);
    await new Promise((r) => setTimeout(r, 100));
    drop(dir, 1);
    const run = await hub.runCuratorOnce();
    expect(run!.error).toMatch(/disk full/);
    expect(entryFiles(dir)).toHaveLength(1);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    await until(() => events.types().includes("sweep_finished"), "sweep_finished");
    expect(pairs(events)).toEqual({ s: 1, f: 1 });
  }, 30_000);

  it("a markProcessed failure after the commit and the receipt: same", async () => {
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, markProcessed: () => { throw new Error("EROFS"); } }) }) });
    const events = followEvents(hub);
    await new Promise((r) => setTimeout(r, 100));
    drop(dir, 1);
    const run = await hub.runCuratorOnce();
    expect(run!.error).toMatch(/EROFS/);
    expect(entryFiles(dir)).toHaveLength(1);
    expect(readdirSync(join(dir, "kb", "ops", "receipts", "alpha"))).toHaveLength(1);
    await until(() => events.types().includes("sweep_finished"), "sweep_finished");
    expect(pairs(events)).toEqual({ s: 1, f: 1 });
  }, 30_000);

  it("a throw mid-tick (outside any item) still pairs sweep_started with sweep_finished", async () => {
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, renderDomain: () => { throw new Error("render blew up"); }, gitCommit: () => { throw new Error("late blow up"); } }) }) });
    const events = followEvents(hub);
    await new Promise((r) => setTimeout(r, 100));
    drop(dir, 1);
    await hub.runCuratorOnce();
    await new Promise((r) => setTimeout(r, 200));
    expect(pairs(events)).toEqual({ s: 1, f: 1 });
    // the curator keeps working afterwards
    await expect(hub.runCuratorOnce()).resolves.toBeDefined();
  }, 30_000);

  it("engine.call and embed run WITHOUT the KB writer queue held (a commit from inside them completes)", async () => {
    let inCall = 0;
    let inEmbed = 0;
    let hubRef: HubServer | undefined;
    const probe = async (n: number) => {
      const content = `---\nid: kb-wp-probe0${n}\n---\nprobe`;
      const r = await Promise.race([
        hubRef!.commitKb({ id: "operator", kind: "operator" } as any, { changes: [{ op: "create", domain: "wp", path: `entries/kb-wp-probe0${n}.md`, content, contentHash: contentHash(content), prevHash: null }] } as any).then(() => "done", () => "done"),
        new Promise((res) => setTimeout(() => res("held"), 1500)),
      ]);
      return r;
    };
    const results: unknown[] = [];
    const slowEngine = { ...engine, call: async (...a: [string, any]) => { if (inCall++ === 0) results.push(await probe(1)); return (engine as any).call(...a); } };
    const slowEmbedder = { ...embedder, embed: async () => { if (inEmbed++ === 0) results.push(await probe(2)); return [1, 0, 0]; } };
    const { hub, dir } = await start({ curator: curatorOpts({ createEngine: () => slowEngine, getEmbedder: () => slowEmbedder }) });
    hubRef = hub;
    drop(dir, 1);
    await hub.runCuratorOnce();
    expect(inCall).toBeGreaterThan(0);
    expect(results).toEqual(["done", "done"]);
  }, 30_000);

  it("pause waits for the tick in flight and blocks new ticks until resumed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCall = new Promise<void>((r) => (entered = r));
    const gated = { ...engine, call: async (...a: [string, any]) => { entered(); await gate; return (engine as any).call(...a); } };
    const { hub, dir } = await start({ curator: curatorOpts({ createEngine: () => gated }) });
    drop(dir, 1);
    const tick = hub.runCuratorOnce();
    await inCall;
    let paused = false;
    const pausing = hub.pauseCurator().then((resume) => { paused = true; return resume; });
    await new Promise((r) => setTimeout(r, 100));
    expect(paused).toBe(false); // the tick is still in flight
    release();
    const resume = await pausing;
    expect((await tick)!.outcome).toBe("ran"); // the tick in flight was allowed to finish
    expect(await hub.runCuratorOnce()).toMatchObject({ outcome: "skipped" });
    expect(existsSync(leaseFile(contributionsRoot(dir)))).toBe(true); // the lease is kept while paused
    resume();
    expect((await hub.runCuratorOnce())!.outcome).not.toBe("skipped");
  }, 30_000);

  it("pause is refused (busy) when the tick in flight outlives the bounded wait, and ticks resume afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCall = new Promise<void>((r) => (entered = r));
    const gated = { ...engine, call: async (...a: [string, any]) => { entered(); await gate; return (engine as any).call(...a); } };
    const { hub, dir } = await start({ curator: curatorOpts({ createEngine: () => gated, closeWaitMs: 50 }) });
    drop(dir, 1);
    const tick = hub.runCuratorOnce();
    await inCall;
    await expect(hub.pauseCurator()).rejects.toMatchObject({ code: "busy" });
    release();
    await tick;
    drop(dir, 1);
    expect((await hub.runCuratorOnce())!.outcome).not.toBe("skipped"); // the refused pause left no pause count behind
  }, 30_000);

  it("close() while a tick is in flight: nothing is written after the close, the lease stays until the tick ends, then goes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCall = new Promise<void>((r) => (entered = r));
    const gated = { ...engine, call: async (...a: [string, any]) => { entered(); await gate; return (engine as any).call(...a); } };
    const { hub, dir } = await start({ curator: curatorOpts({ createEngine: () => gated, closeWaitMs: 50 }) });
    drop(dir, 1);
    const tick = hub.runCuratorOnce();
    await inCall;
    await hub.close();
    servers.pop();
    // closed, tick still running: the lease is still held
    expect(existsSync(leaseFile(contributionsRoot(dir)))).toBe(true);
    release();
    await tick;
    await until(() => !existsSync(leaseFile(contributionsRoot(dir))), "lease released after the tick ended");
    // nothing was written once the hub was closing
    expect(existsSync(join(dir, "kb", "ops", "receipts", "alpha"))).toBe(false);
    expect(existsSync(join(lane(dir), "_processed"))).toBe(false);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  }, 30_000);

  it("close() landing between commitEntry and appendLedger lets the item finish: one entry, one entry_written, a receipt, the _processed move, then the lease goes", async () => {
    let reached!: () => void;
    const atLedger = new Promise<void>((r) => (reached = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    let first = true;
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, appendLedger: async (...a: unknown[]) => { if (first) { first = false; reached(); await gate; } return w.appendLedger(...a); } }) }) });
    drop(dir, 1);
    const tick = hub.runCuratorOnce();
    await atLedger; // the entry is committed, the contribution is not yet marked seen
    expect(entryFiles(dir)).toHaveLength(1);
    const closing = hub.close();
    servers.pop();
    await new Promise((r) => setTimeout(r, 100));
    go();
    const run = await tick;
    await closing;
    expect(run!.error).toBeUndefined();
    expect(run).toMatchObject({ processed: 1, created: 1 });
    expect(entryFiles(dir)).toHaveLength(1);
    const ledger = readLedger(hub.roots) as Array<{ t: string }>;
    expect(ledger.filter((e) => e.t === "entry_written")).toHaveLength(1);
    expect(ledger.filter((e) => e.t === "contribution")).toHaveLength(1); // seen: a restart does not create it again
    expect(readdirSync(join(dir, "kb", "ops", "receipts", "alpha"))).toHaveLength(1);
    expect(readdirSync(join(lane(dir), "_processed"))).toHaveLength(1);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    await until(() => !existsSync(leaseFile(contributionsRoot(dir))), "lease released");
  }, 30_000);

  it("unchanged path: close() after the ledger append (contribution seen, nothing committed) still gets the receipt and the _processed move", async () => {
    let reached!: () => void;
    const atLedger = new Promise<void>((r) => (reached = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    let armed = false;
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, appendLedger: async (...a: unknown[]) => { const r = await w.appendLedger(...a); if (armed) { armed = false; reached(); await gate; } return r; } }) }) });
    // An anchored verbatim contribution, sent twice with identical text and source (only the hash differs): the second one is
    // "unchanged": nothing to commit, but its ledger append still marks the contribution seen.
    const anchored = (n: number) => {
      mkdirSync(lane(dir), { recursive: true });
      writeFileSync(join(lane(dir), `rule-${n}-aaaaaaaaaa.md`), `---\nfrom: alpha\nden_topic_id: work-wp-FEAT001\ncontent_hash: sha256:c0de${n}\nprev_hash: null\ndomain_hint: wp\nanchor: work-wp-FEAT001\nverbatim: true\n---\n\n# A rule\n\nsame body\n`);
    };
    anchored(1);
    await hub.runCuratorOnce(); // creates the entry
    anchored(2);
    const writtenBefore = ledgerCount(hub, "entry_written");
    armed = true;
    const tick = hub.runCuratorOnce();
    await atLedger;
    expect(ledgerCount(hub, "entry_written")).toBe(writtenBefore); // nothing was committed for this item
    const closing = hub.close();
    servers.pop();
    await new Promise((r) => setTimeout(r, 100));
    go();
    const run = await tick;
    await closing;
    expect(run!.error).toBeUndefined();
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(readdirSync(join(lane(dir), "_processed"))).toHaveLength(2);
    expect(readdirSync(join(dir, "kb", "ops", "receipts", "alpha"))).toHaveLength(2); // the unchanged item has its receipt
    expect(entryFiles(dir)).toHaveLength(1);
  }, 30_000);

  it("no lease leaks when start() or a later startup step throws", async () => {
    const dir = freshDir();
    await expect(createHubServer({ dataDir: dir, port: 0, curator: curatorOpts({ pollMs: 1000, afterStart: () => { throw new Error("startup step failed"); } }) })).rejects.toThrow(/startup step failed/);
    expect(existsSync(leaseFile(contributionsRoot(dir)))).toBe(false);
    const again = await createHubServer({ dataDir: dir, port: 0, curator: curatorOpts() }); // and a retry can take it
    servers.push(again);
  }, 30_000);
});

describe("hub curator: entry_written dedupe is per commit", () => {
  const roots = () => { const b = mkdtempSync(join(tmpdir(), "hubd-dedupe-")); tmp.push(b); return { kbBase: join(b, "base"), opsRoot: join(b, "ops"), denLocal: join(b, "den") } as any; };
  const ew = (id: string) => ({ id: "x", at: "t", t: "entry_written", entryId: id, canonicalId: id, action: "create" }) as any;

  it("drops one sweep entry_written per committed entry, keeps the others, and a patch adds none", async () => {
    const r = roots();
    const commits: unknown[] = [];
    const w = createHubSweepWriter({ commit: async (_a: any, req: any) => (commits.push(req), {} as any), exclusive: async (fn: any) => fn() });
    // two commits of the same id in one tick (create, then a merge rewrite): two pending
    w.pending.set("kb-wp-aaaaaaa", 2);
    await w.appendLedger(r, [ew("kb-wp-aaaaaaa"), ew("kb-wp-bbbbbbb")]);
    expect(w.pending.get("kb-wp-aaaaaaa")).toBe(1); // one consumed, one still owed
    expect(readLedger(r).map((e: any) => e.entryId)).toEqual(["kb-wp-bbbbbbb"]); // only the id nobody committed through commitKb
    await w.appendLedger(r, [ew("kb-wp-aaaaaaa")]);
    expect(w.pending.size).toBe(0);
    // a patch of an existing entry goes through commit but owes no drop: its sweep-made entry_written (none) is never swallowed
    await w.patchEntry(r, "wp", "kb-wp-ccccccc", "patched");
    expect(w.pending.size).toBe(0);
    await w.appendLedger(r, [ew("kb-wp-ccccccc")]);
    expect(readLedger(r).map((e: any) => e.entryId)).toEqual(["kb-wp-bbbbbbb", "kb-wp-ccccccc"]);
    expect(SYSTEM_ACTOR.kind).toBe("system");
  });

  it("a decision event is not an entry_written: it passes through, consumes no owed drop, and does not open the close gate's committed flag", async () => {
    const r = roots();
    let closing = false;
    const w = createHubSweepWriter({ commit: async () => ({}) as any, exclusive: async (fn: any) => fn(), closing: () => closing });
    w.pending.set("kb-wp-aaaaaaa", 1);
    const dec = { id: "d", at: "t", t: "decision", from: "alpha", denTopicId: "x", hash: "h", outcome: "reject", reason: "r" } as any;
    await w.appendLedger(r, [dec]);
    expect(w.pending.get("kb-wp-aaaaaaa")).toBe(1);
    expect(readLedger(r).map((e: any) => e.t)).toEqual(["decision"]);
    // closing: the reject path's decision append (after its receipt and move) is allowed, but a decision alone does not mark the item
    // committed, so a later write that opens a new item is still refused.
    closing = true;
    await w.appendLedger(r, [{ ...dec, id: "d2" }]);
    await expect(w.writeReceipt(r, "alpha", {} as any, "reject", "x")).rejects.toThrow(/shutting down/);
  });

  it("a failed ledger append consumes nothing (the owed drops survive a retry)", async () => {
    const r = roots();
    const w = createHubSweepWriter({ commit: async () => ({}) as any, exclusive: async () => { throw new Error("append failed"); } });
    w.pending.set("kb-wp-aaaaaaa", 1);
    await expect(w.appendLedger(r, [ew("kb-wp-aaaaaaa"), ew("kb-wp-bbbbbbb")])).rejects.toThrow(/append failed/);
    expect(w.pending.get("kb-wp-aaaaaaa")).toBe(1);
  });
});

describe("hub curator: commit intent closes the commit→append window", () => {
  it("appendLedger failing after commitEntry leaves a live entry with the contribution unseen; the outcome of the next tick is pinned here", async () => {
    let failed = false;
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, appendLedger: async (...a: unknown[]) => { if (!failed) { failed = true; throw new Error("ledger down"); } return w.appendLedger(...a); } }) }) });
    drop(dir, 1);
    const first = await hub.runCuratorOnce();
    expect(first!.error).toMatch(/ledger down/);
    expect(entryFiles(dir)).toHaveLength(1);
    expect(ledgerCount(hub, "entry_written")).toBe(1); // commitKb logged it
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(1); // still queued, hash not marked seen
    // sweep.ts keeps the unwritten batch and appends it again in its final ledger write, so a FAILING (not crashing) append is
    // repaired in the same tick: the contribution is seen by the next tick, which retires it as a duplicate. Still one entry,
    // one entry_written, no second create; the contributor gets no receipt for it (it was never answered).
    expect(ledgerCount(hub, "contribution")).toBe(1);
    await hub.runCuratorOnce();
    expect(entryFiles(dir)).toHaveLength(1);
    expect(ledgerCount(hub, "entry_written")).toBe(1);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(existsSync(join(dir, "kb", "ops", "receipts", "alpha"))).toBe(false);
  }, 30_000);

  it("a restart between commitEntry and appendLedger: the intent is replayed, no second entry, one entry_written, the item is retired", async () => {
    const { hub, dir } = await start({ curator: curatorOpts({ wrapWriter: (w: any) => ({ ...w, appendLedger: async () => { throw new Error("process died"); } }) }) });
    drop(dir, 1);
    const first = await hub.runCuratorOnce();
    expect(first!.error).toBeDefined();
    expect(entryFiles(dir)).toHaveLength(1);
    expect(ledgerCount(hub, "contribution")).toBe(0); // unseen: exactly the window
    expect(existsSync(join(dir, "kb", "ops", "pending-commit.json"))).toBe(true);
    await hub.close();
    servers.pop();
    const { hub: hub2 } = await start({ curator: curatorOpts() }, dir); // restart on the same data dir
    await hub2.runCuratorOnce();
    await hub2.runCuratorOnce();
    expect(entryFiles(dir)).toHaveLength(1);
    expect(ledgerCount(hub2, "contribution")).toBe(1);
    expect(ledgerCount(hub2, "entry_written")).toBe(1); // commitKb's, not doubled by the replay
    expect(ledgerCount(hub2, "decision")).toBe(1);
    expect(readdirSync(lane(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    expect(existsSync(join(dir, "kb", "ops", "pending-commit.json"))).toBe(false);
  }, 30_000);
});
