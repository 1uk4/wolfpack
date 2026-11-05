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
