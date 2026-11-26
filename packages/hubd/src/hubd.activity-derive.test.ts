/** Hub-derived activity (activity/derive.ts): Work ledger appends and KB commits publish contribution / shipped / kb-write events. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@wolfpack/kb/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "@wolfpack/protocol";
import { parseWorkEvent } from "@wolfpack/kb/client";
import { createMemoryBus, type ActivityBus } from "./activity/bus.js";
import { createActivityDeriver } from "./activity/derive.js";
import { createPresenceStore } from "./activity/presence.js";
import { createHubServer, type HubServer } from "./server.js";
import { OP, seedTokens, workerTokenFor } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function rig(wrap?: (b: ActivityBus) => ActivityBus) {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-derive-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA"]);
  const base = join(dataDir, "kb", "base");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "domains.yaml"), "domains:\n  personal:\n    label: Personal\n");
  const inner = createMemoryBus();
  const seen: ActivityEvent[] = [];
  inner.subscribe("default", (e) => seen.push(e));
  const hub = await createHubServer({ dataDir, activityBus: wrap ? wrap(inner) : inner });
  servers.push(hub);
  const reg = (p: string, b: unknown) => fetch(hub.url + p, { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(b) });
  await reg("/v1/registry/domains", { name: "personal" });
  await reg("/v1/registry/hosts", { name: "hA" });
  await reg("/v1/registry/wolves", { name: "wa", host: "hA", domains: ["personal"] });
  const A = workerTokenFor("hA");
  const wolf = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": A, "X-Wolf": "wa", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const owner = (method: string, path: string, body?: unknown) =>
    fetch(`${hub.url}/v1/work${path}`, { method, headers: { ...OP, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  return { hub, seen, wolf, owner, settle };
}
const feature = { kind: "feature", domain: "personal", title: "Derive me", assignee: "wa", body: "x" };
const create = async (r: Awaited<ReturnType<typeof rig>>, headers: Record<string, string> = {}) =>
  ((await (await r.wolf("POST", "", feature, headers)).json()) as { id: string }).id;

describe("derive actor trust", () => {
  const mk = () => {
    const bus = createMemoryBus();
    const seen: ActivityEvent[] = [];
    bus.subscribe("p", (e) => seen.push(e));
    return { seen, d: createActivityDeriver({ bus, presence: createPresenceStore(), pack: "p" }) };
  };

  it("a kb-write is attributed to the token's wolf, not to the X-Wolf header", async () => {
    const { seen, d } = mk();
    d.run({ "x-wolf": "other" }, () => {
      d.setWorker(true, "wa");
      d.onKb(["kb-personal-aaaaaaa"], "personal");
    });
    await new Promise((r) => setImmediate(r));
    expect(seen.map((e) => e.actor)).toEqual([{ kind: "wolf", wolf: "wa" }]);
  });

  it("a work.staged event in the real WorkEvent shape publishes shipped (the destination stage is `to`)", async () => {
    const { seen, d } = mk();
    const ev = parseWorkEvent({ type: "work.staged", id: "work-personal-Aaaaaaa", at: "2026-01-01 00:00", to: "shipped" })!;
    d.run({}, () => d.onLedger({ actor: { id: "owner", kind: "operator" }, events: [ev] }));
    await new Promise((r) => setImmediate(r));
    expect(seen.map((e) => e.verb)).toEqual(["shipped"]);
  });
});

describe("derive fan-out queue", () => {
  const ledger = (n: number) =>
    Array.from({ length: n }, (_, i) => parseWorkEvent({ type: "work.staged", id: `work-personal-A${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}aaaa`, at: "2026-01-01 00:00", to: "shipped" })!);
  const mk = () => {
    const bus = createMemoryBus();
    const seen: ActivityEvent[] = [];
    bus.subscribe("p", (e) => seen.push(e));
    return { seen, d: createActivityDeriver({ bus, presence: createPresenceStore(), pack: "p" }) };
  };
  const drain = () => new Promise((r) => setTimeout(r, 30));

  it("the ledger hook returns before any subscriber is written to, and delivery keeps the append order", async () => {
    const { seen, d } = mk();
    d.run({}, () => d.onLedger({ actor: { id: "owner", kind: "operator" }, events: ledger(5) }));
    expect(seen).toHaveLength(0);
    await drain();
    expect(seen.map((e) => e.target!.id)).toEqual(ledger(5).map((e) => e.id));
  });

  it("a KB commit with no request context (curator, system) publishes kb-write by a hub actor, at most 20 per commit, after the hook returned, and never into presence", async () => {
    const { seen, d } = mk();
    const ids = Array.from({ length: 30 }, (_, i) => `kb-personal-a${i}`);
    d.onKb(ids, "personal");
    expect(seen).toHaveLength(0);
    await drain();
    expect(seen).toHaveLength(20);
    expect(seen[0]).toMatchObject({ verb: "kb-write", actor: { kind: "hub", title: "curator" }, target: { kind: "kb-entry", id: "kb-personal-a0", domain: "personal" }, domain: "personal" });
    expect(seen[0]!.actor.wolf).toBeUndefined();
  });

  it("derives at most 20 events from one ledger batch, and drains a big backlog in chunks of 50", async () => {
    const { seen, d } = mk();
    for (let i = 0; i < 6; i++) d.run({}, () => d.onLedger({ actor: { id: "owner", kind: "operator" }, events: ledger(100) }));
    await drain();
    expect(seen).toHaveLength(120);
    const bus = createMemoryBus();
    let during = 0;
    const marks: number[] = [];
    bus.subscribe("p", () => { during++; });
    const d2 = createActivityDeriver({ bus, presence: createPresenceStore(), pack: "p" });
    for (let i = 0; i < 6; i++) d2.run({}, () => d2.onLedger({ actor: { id: "owner", kind: "operator" }, events: ledger(20) }));
    setImmediate(() => marks.push(during));
    await drain();
    expect(marks[0]).toBeLessThanOrEqual(100);
    expect(during).toBe(120);
  });
});

describe("hub-derived activity", () => {
  it("a Work write with thread headers publishes a contribution by that thread, on the bus and on SSE", async () => {
    const r = await rig();
    const ctl = new AbortController();
    const res = await fetch(r.hub.url + "/v1/events?activity=1", { headers: OP, signal: ctl.signal });
    const reader = res.body!.getReader();
    let buf = "";
    void (async () => { try { for (;;) { const x = await reader.read(); if (x.done) return; buf += new TextDecoder().decode(x.value); } } catch { /* aborted */ } })();
    const id = await create(r, { "x-wolfpack-thread-id": "t-9", "x-wolfpack-subagent": "scout" });
    await r.settle();
    ctl.abort();
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({ verb: "contribution", actor: { kind: "subagent", wolf: "wa", threadId: "t-9", subagent: "scout" }, target: { kind: "work-item", id, title: "Derive me" } });
    expect(buf).toContain('"type":"pack.activity"');
    expect(buf).toContain('"threadId":"t-9"');
  });

  it("without headers the actor is the wolf alone, and an owner write is an owner actor", async () => {
    const r = await rig();
    const id = await create(r);
    await r.owner("PATCH", `/${id}`, { ops: [{ note: "hi" }] });
    expect(r.seen.map((e) => e.actor)).toEqual([{ kind: "wolf", wolf: "wa" }, { kind: "owner" }]);
  });

  it("a stage move to shipped publishes shipped, not contribution", async () => {
    const r = await rig();
    const id = await create(r);
    r.seen.length = 0;
    expect((await r.owner("PATCH", `/${id}`, { ops: [{ stage: "shipped" }] })).status).toBe(200);
    expect(r.seen.map((e) => e.verb)).toEqual(["shipped"]);
    expect(r.seen[0]!.target!.id).toBe(id);
  });

  it("a failed write publishes nothing", async () => {
    const r = await rig();
    const res = await r.wolf("PATCH", "/work-personal-Zzzzzzz", { ops: [{ note: "x" }] });
    expect(res.status).toBe(404);
    expect(r.seen).toEqual([]);
  });

  it("a throwing bus does not fail the write", async () => {
    const r = await rig((b) => ({ publish: () => { throw new Error("boom"); }, subscribe: b.subscribe.bind(b) }));
    const res = await r.wolf("POST", "", feature);
    expect(res.status).toBe(201);
  });

  it("a KB commit publishes kb-write for the entry; the hub's own writes publish nothing", async () => {
    const r = await rig();
    const content = '---\nid: kb-personal-aaaaaaa\ntitle: "Hello"\ndomain: personal\n---\n\n# Hello\n\nBody.\n';
    const res = await fetch(r.hub.url + "/v1/kb/commits", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OP },
      body: JSON.stringify({ changes: [{ op: "create", domain: "personal", path: "entries/kb-personal-aaaaaaa.md", content, contentHash: contentHash(content), prevHash: null }] }),
    });
    expect(res.status).toBeLessThan(300);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({ verb: "kb-write", actor: { kind: "owner" }, target: { kind: "kb-entry", id: "kb-personal-aaaaaaa", domain: "personal" } });
  });
});
