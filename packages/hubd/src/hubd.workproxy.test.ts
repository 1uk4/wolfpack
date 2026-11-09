/** The hub-proxied Work API (work-proxy.ts): shapes of the agent's /work routes, whitelist, and worker-token scoping. */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { workLedgerFile } from "@wolfpack/kb/shared";
import { createHubServer as createRaw, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { applyOps } from "./work-writes.js";
import { OP, OP_TOKEN, seedTokens, workerTokenFor } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-wproxy-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA", "hB"]);
  const hub = await createRaw({ dataDir });
  servers.push(hub);
  const reg = (p: string, b: unknown, m = "POST") => fetch(hub.url + p, { method: m, headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(b) });
  for (const d of ["personal", "other"]) await reg("/v1/registry/domains", { name: d });
  for (const h of ["hA", "hB"]) await reg("/v1/registry/hosts", { name: h });
  await reg("/v1/registry/wolves", { name: "wa", host: "hA", domains: ["personal"] });
  await reg("/v1/registry/wolves", { name: "wb", host: "hB", domains: ["other"] });
  // the proxy speaks X-API-Key (what the Work clients send); a bearer is accepted too
  const call = (key: string, method: string, path: string, body?: unknown, wolf?: string) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": key, ...(wolf ? { "X-Wolf": wolf } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const A = workerTokenFor("hA");
  const B = workerTokenFor("hB");
  return { hub, call, A, B, reg };
}
const feature = { kind: "feature", domain: "personal", title: "Proxy me", assignee: "wa", body: "x" };

describe("hub work proxy", () => {
  it("rejects a missing/invalid key (401) and accepts the worker token as X-API-Key", async () => {
    const { call, hub, A } = await rig();
    expect((await fetch(`${hub.url}/v1/workapi/work`)).status).toBe(401);
    expect((await call("nope", "GET", "")).status).toBe(401);
    const r = await call(A, "GET", "?domain=personal");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [] });
    // the key is NOT accepted on any other prefix
    expect((await fetch(`${hub.url}/v1/work?domain=personal`, { headers: { "X-API-Key": A } })).status).toBe(401);
  });

  it("create / get / patch / graduate keep the agent shapes for the wolf's own host", async () => {
    const { call, A } = await rig();
    const c = await call(A, "POST", "", feature);
    expect(c.status).toBe(201);
    const { id, item } = (await c.json()) as { id: string; item: { assignee: string } };
    expect(id).toMatch(/^work-personal-/);
    expect(item.assignee).toBe("wa");
    const g = await call(A, "GET", `/${id}`);
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ item: { id }, body: expect.anything() });
    const t = await call(A, "POST", "", { kind: "task", domain: "personal", title: "T", assignee: "wa", partOf: id, successCriteria: "ok" });
    const tid = ((await t.json()) as { id: string }).id;
    expect((await call(A, "PATCH", `/${tid}`, { stage: "shipped" })).status).toBe(200);
    expect((await call(A, "PATCH", `/${id}`, { note: "hello" })).status).toBe(200);
    const list = (await (await call(A, "GET", `?partOf=${id}`)).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([tid]);
    expect((await call(A, "POST", `/${id}/graduate`)).status).toBe(200);
  });

  it("answers 409 parent_closed (create and move) for a graduated parent, with the message", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    const t = await call(A, "POST", "", { kind: "task", domain: "personal", title: "T", assignee: "wa" }); // parentless: lands in the Inbox
    const tid = ((await t.json()) as { id: string }).id;
    expect((await call(A, "POST", `/${id}/graduate`)).status).toBe(200);
    const c = await call(A, "POST", "", { kind: "task", domain: "personal", title: "late", assignee: "wa", partOf: id });
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ code: "parent_closed", error: expect.stringContaining(`${id} "`) });
    const mv = await call(A, "PATCH", `/${tid}`, { moveTo: id });
    expect(mv.status).toBe(409);
    expect(((await mv.json()) as { error: string }).error).toContain("has graduated");
  });

  it("a worker token cannot see, change or graduate another host's work, nor create for a foreign wolf/domain", async () => {
    const { call, A, B } = await rig();
    const mine = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    // B (host hB, domain other): the item is absent for reads
    expect((await call(B, "GET", `/${mine}`)).status).toBe(404);
    expect(((await (await call(B, "GET", "")).json()) as { items: unknown[] }).items).toEqual([]);
    // writes: only the assignee gate applies (no domain check); another wolf's item is refused, notes excepted
    expect((await call(B, "PATCH", `/${mine}`, { stage: "approved" })).status).toBe(403);
    expect((await call(B, "POST", `/${mine}/graduate`)).status).toBe(403);
    // create: foreign assignee, foreign domain
    expect((await call(A, "POST", "", { ...feature, assignee: "wb" })).status).toBe(403);
    expect((await call(A, "POST", "", { ...feature, domain: "other" })).status).toBe(403);
    // an item in A's domain assigned to a wolf A does not own is read-only to A
    const op = ((await (await call(OP_TOKEN, "POST", "", { ...feature, assignee: "wb" })).json()) as { id: string }).id;
    expect((await call(A, "GET", `/${op}`)).status).toBe(200);
    expect((await call(A, "PATCH", `/${op}`, { stage: "approved" })).status).toBe(403);
    expect((await call(A, "POST", `/${op}/graduate`)).status).toBe(403);
  });

  it("whitelist: no DELETE, no unknown paths; malformed ids and bodies are 400", async () => {
    const { call, A, hub } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(A, "DELETE", `/${id}`)).status).toBe(400);
    expect((await call(A, "GET", `/${id}/extra/segments`)).status).toBe(404);
    expect((await call(A, "GET", "/not-an-id")).status).toBe(400);
    expect((await call(A, "POST", "", { kind: "feature" })).status).toBe(400);
    expect((await call(A, "PATCH", `/${id}`, { bogus: 1 })).status).toBe(400);
    expect((await fetch(`${hub.url}/v1/workapi/other`, { headers: { Authorization: `Bearer ${A}` } })).status).toBe(404);
    expect((await fetch(`${hub.url}/v1/workapi/other`, { headers: { "X-API-Key": A } })).status).toBe(401); // the key header only works under /work
  });

  it("a write resent with the same Idempotency-Key gets the first answer and is not applied again, also after a restart", async () => {
    const { hub, A } = await rig();
    const keyed = (url: string, key: string, method: string, path: string, body: unknown) =>
      fetch(`${url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const first = await keyed(hub.url, "k-create-1", "POST", "", feature);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const again = await keyed(hub.url, "k-create-1", "POST", "", feature);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(id);
    expect((await keyed(hub.url, "k-note-1", "PATCH", `/${id}`, { note: "only-once-marker" })).status).toBe(200);

    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    const hub2 = await createRaw({ dataDir });
    servers.push(hub2);
    expect((await keyed(hub2.url, "k-note-1", "PATCH", `/${id}`, { note: "only-once-marker" })).status).toBe(200);
    // a key the hub cannot store is refused, not silently ignored (the write would then not be deduplicated)
    expect((await keyed(hub2.url, "bad key with spaces", "POST", "", feature)).status).toBe(400);
    // a read never uses a key, so a malformed one on a GET is ignored, not refused
    expect((await fetch(`${hub2.url}/v1/workapi/work/${id}`, { headers: { "X-API-Key": A, "Idempotency-Key": "bad key with spaces" } })).status).toBe(200);
    const list = (await (await fetch(`${hub2.url}/v1/workapi/work?domain=personal`, { headers: { "X-API-Key": A } })).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([id]);
    const got = (await (await fetch(`${hub2.url}/v1/workapi/work/${id}`, { headers: { "X-API-Key": A } })).json()) as { item: { log: { text: string }[] } };
    expect(got.item.log.filter((l) => l.text === "only-once-marker")).toHaveLength(1);
  });

  it("a torn last line of the key store (a crash mid-append) is skipped: earlier keys still dedup and new keys are stored", async () => {
    const { hub, A } = await rig();
    const keyed = (url: string, key: string, body: unknown) =>
      fetch(`${url}/v1/workapi/work`, { method: "POST", headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const id = ((await (await keyed(hub.url, "k-a", feature)).json()) as { id: string }).id;
    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    appendFileSync(join(dataDir, "link", "work-idempotency.jsonl"), '{"k":"torn');
    const hub2 = await createRaw({ dataDir });
    servers.push(hub2);
    expect(((await (await keyed(hub2.url, "k-a", feature)).json()) as { id: string }).id).toBe(id);
    const id2 = ((await (await keyed(hub2.url, "k-b", { ...feature, title: "Second" })).json()) as { id: string }).id;
    await servers.pop()!.close();
    const hub3 = await createRaw({ dataDir });
    servers.push(hub3);
    expect(((await (await keyed(hub3.url, "k-b", { ...feature, title: "Second" })).json()) as { id: string }).id).toBe(id2);
    const list = (await (await fetch(`${hub3.url}/v1/workapi/work?domain=personal`, { headers: { "X-API-Key": A } })).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id).sort()).toEqual([id, id2].sort());
  });

  it("a key is remembered for 7 days whatever happens in between, and forgotten after", async () => {
    const { hub, A } = await rig();
    const dataDir = hub.dataDir;
    await servers.pop()!.close();
    let t = Date.parse("2026-11-01T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const hubT = await createRaw({ dataDir, now: () => t });
    servers.push(hubT);
    const keyed = (key: string) =>
      fetch(`${hubT.url}/v1/workapi/work`, { method: "POST", headers: { "X-API-Key": A, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(feature) });
    const id = ((await (await keyed("k-old")).json()) as { id: string }).id;
    t += 6 * day;
    expect(((await (await keyed("k-old")).json()) as { id: string }).id).toBe(id);
    t += 2 * day;
    expect(((await (await keyed("k-old")).json()) as { id: string }).id).not.toBe(id);
  });

  // ── the per-wolf assignee gate: wa and wa2 share host hA; the owner is OP_TOKEN ──
  async function gateRig() {
    const r = await rig();
    await r.reg("/v1/registry/wolves", { name: "wa2", host: "hA", domains: ["personal"] });
    const as = (w: string, method: string, path: string, body?: unknown) => r.call(r.A, method, path, body, w);
    const owner = (method: string, path: string, body?: unknown) => r.call(OP_TOKEN, method, path, body);
    type Out = { id: string; error: string; item: { assignee: string }; reassigned?: { id: string; from: string; to: string }[]; assignedTo?: string };
    const json = async (x: Response) => (await x.json()) as Out;
    const mk = async (b: object) => (await json(await owner("POST", "", { domain: "personal", assignee: "wa", ...b }))).id;
    const who = async (id: string) => (await json(await owner("GET", `/${id}`))).item.assignee;
    return { ...r, as, owner, json, mk, who };
  }

  it("the owner assigns any item", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "loose", body: "x", assignee: "wb" });
    const o = await g.owner("PATCH", `/${id}`, { assignee: "wa" });
    expect(o.status).toBe(200);
    expect((await g.json(o)).item.assignee).toBe("wa");
  });

  it("a wolf hands off its own item and is then refused it", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa", "PATCH", `/${id}`, { assignee: "wa2" })).status).toBe(200);
    const after = await g.as("wa", "PATCH", `/${id}`, { stage: "approved" });
    expect(after.status).toBe(403);
    expect((await g.json(after)).error).toBe("assigned to wa2; only wa2 or the owner can change it");
  });

  it("a wolf is refused another wolf's item on the same host, with the exact message", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    const r = await g.as("wa2", "PATCH", `/${id}`, { title: "mine now" });
    expect(r.status).toBe(403);
    expect((await g.json(r)).error).toBe("assigned to wa; only wa or the owner can change it");
  });

  it("graduate by a non-assignee is refused", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa2", "POST", `/${id}/graduate`)).status).toBe(403);
  });

  it("a note on another wolf's item is allowed, but a batch of a note plus another op is refused", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    expect((await g.as("wa2", "PATCH", `/${id}`, { note: "fyi" })).status).toBe(200);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ note: "fyi" }, { title: "x" }] })).status).toBe(403);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ note: "one" }, { note: "two" }] })).status).toBe(200);
  });

  it("any wolf replaces the Record section of another wolf's item; plan, full body and mixed batches stay gated", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "the plan" });
    expect((await g.owner("PATCH", `/${id}`, { section: { name: "Plan", text: "the plan" } })).status).toBe(200);
    const rec = await g.as("wa2", "PATCH", `/${id}`, { section: { name: "Record", text: "### Decisions\n\n- one" } });
    expect(rec.status).toBe(200);
    const body = ((await (await g.as("wa2", "GET", `/${id}`)).json()) as { body: string }).body;
    expect(body).toContain("## Record\n\n### Decisions\n\n- one");
    expect(body).toContain("the plan");
    const refusal = "assigned to wa; only wa or the owner can change it";
    const plan = await g.as("wa2", "PATCH", `/${id}`, { section: { name: "Plan", text: "mine" } });
    expect(plan.status).toBe(403);
    expect((await g.json(plan)).error).toBe(refusal);
    expect((await g.as("wa2", "PATCH", `/${id}`, { body: "all mine" })).status).toBe(403);
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ section: { name: "Record", text: "x" } }, { section: { name: "Plan", text: "mine" } }] })).status).toBe(403);
    // a ledger op beside a section is refused by the batch rule, never applied
    expect((await g.as("wa2", "PATCH", `/${id}`, { ops: [{ section: { name: "Record", text: "x" } }, { stage: "approved" }] })).status).toBe(400);
  });

  it("an unknown assign target is a 400 that names it, for the owner too", async () => {
    const g = await gateRig();
    const id = await g.mk({ kind: "feature", title: "F", body: "x" });
    for (const call of [() => g.owner("PATCH", `/${id}`, { assignee: "ghost" }), () => g.as("wa", "PATCH", `/${id}`, { assignee: "ghost" })]) {
      const r = await call();
      expect(r.status).toBe(400);
      expect((await g.json(r)).error).toContain("\"ghost\"");
    }
    expect(await g.who(id)).toBe("wa");
  });

  it("a wolf reassigns a child task it holds, and moves one to the Inbox with the assignee unchanged", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const t1 = await g.mk({ kind: "task", title: "t1", partOf: feat, successCriteria: "ok" });
    const t2 = await g.mk({ kind: "task", title: "t2", partOf: feat, successCriteria: "ok" });
    expect((await g.as("wa", "PATCH", `/${t1}`, { assignee: "wa2" })).status).toBe(200);
    expect(await g.who(t1)).toBe("wa2");
    const loose = await g.mk({ kind: "task", title: "loose", successCriteria: "ok" }); // lands in the domain's Inbox
    const inbox = ((await (await g.owner("GET", `/${loose}`)).json()) as { item: { partOf: string } }).item.partOf;
    const mv = await g.as("wa", "PATCH", `/${t2}`, { moveTo: inbox });
    expect(mv.status).toBe(200);
    expect((await g.json(mv)).reassigned).toBeUndefined();
    expect(await g.who(t2)).toBe("wa");
  });

  it("moving a task under another wolf's feature hands it to that wolf and says so", async () => {
    const g = await gateRig();
    const featX = await g.mk({ kind: "feature", title: "X's", body: "x", assignee: "wa2" });
    const t = await g.mk({ kind: "task", title: "t", successCriteria: "ok" });
    const mv = await g.as("wa", "PATCH", `/${t}`, { moveTo: featX });
    expect(mv.status).toBe(200);
    expect((await g.json(mv)).reassigned).toEqual([{ id: t, from: "wa", to: "wa2" }]);
    expect(await g.who(t)).toBe("wa2");
    // the handoff is on the ledger as a work.assigned event for the task
    const events = readFileSync(workLedgerFile(hubRoots(g.hub.dataDir)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; id: string; assignee?: string });
    expect(events.filter((e) => e.type === "work.assigned" && e.id === t).map((e) => e.assignee)).toEqual(["wa2"]);
  });

  it("an owner feature assign cascades to all open children, skipping shipped and archived", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const task = (title: string, assignee = "wa") => g.mk({ kind: "task", title, partOf: feat, successCriteria: "ok", assignee });
    const mine = await task("mine");
    const theirs = await task("theirs", "wa2");
    const done = await task("done");
    const arch = await task("arch");
    await g.owner("PATCH", `/${done}`, { stage: "shipped" });
    await g.owner("PATCH", `/${arch}`, { stage: "archived" });
    expect((await g.owner("PATCH", `/${feat}`, { assignee: "wb" })).status).toBe(200);
    expect([await g.who(feat), await g.who(mine), await g.who(theirs), await g.who(done), await g.who(arch)]).toEqual(["wb", "wb", "wb", "wa", "wa"]);
  });

  it("a worker feature assign cascades only to the children it holds, leaving others alone", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const mine = await g.mk({ kind: "task", title: "mine", partOf: feat, successCriteria: "ok" });
    const theirs = await g.mk({ kind: "task", title: "theirs", partOf: feat, successCriteria: "ok", assignee: "wa2" });
    expect((await g.as("wa", "PATCH", `/${feat}`, { assignee: "wb" })).status).toBe(200);
    expect([await g.who(feat), await g.who(mine), await g.who(theirs)]).toEqual(["wb", "wb", "wa2"]);
  });

  it("a feature assign whose cascade fails changes nothing", async () => {
    const g = await gateRig();
    const feat = await g.mk({ kind: "feature", title: "F", body: "x" });
    const kids = [await g.mk({ kind: "task", title: "a", partOf: feat, successCriteria: "ok" }), await g.mk({ kind: "task", title: "b", partOf: feat, successCriteria: "ok" })];
    const scratch = mkdtempSync(join(tmpdir(), "hubd-wproxy-stage-"));
    tmp.push(scratch);
    // fails after the feature and the children were assigned in the scratch copy, before anything reaches the real ledger
    expect(() => applyOps(hubRoots(g.hub.dataDir), feat, [{ op: "assign", to: "wb" }], { afterStaged: () => { throw new Error("boom"); }, tmpRoot: scratch })).toThrow("boom");
    expect([await g.who(feat), await g.who(kids[0]!), await g.who(kids[1]!)]).toEqual(["wa", "wa", "wa"]);
  });

  it("creating under another wolf's feature inherits that wolf; creating loose for another wolf is refused", async () => {
    const g = await gateRig();
    const featX = await g.mk({ kind: "feature", title: "X's", body: "x", assignee: "wa2" });
    const made = await g.json(await g.as("wa", "POST", "", { kind: "task", domain: "personal", title: "N", assignee: "wa", partOf: featX, successCriteria: "ok" }));
    expect(made.item.assignee).toBe("wa2");
    expect(made.assignedTo).toBe("wa2");
    expect((await g.as("wa", "POST", "", { kind: "feature", domain: "personal", title: "L", assignee: "wa2", body: "x" })).status).toBe(403);
  });

  it("creating under a feature held by an unknown wolf is refused", async () => {
    const g = await gateRig();
    const featG = await g.mk({ kind: "feature", title: "Ghost's", body: "x", assignee: "ghost" });
    const r = await g.as("wa", "POST", "", { kind: "task", domain: "personal", title: "N", assignee: "wa", partOf: featG, successCriteria: "ok" });
    expect(r.status).toBe(400);
    expect((await g.json(r)).error).toContain("\"ghost\"");
  });

  it("an operator token is unrestricted over the whitelist", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(OP_TOKEN, "GET", `/${id}`)).status).toBe(200);
    expect((await call(OP_TOKEN, "GET", "")).status).toBe(200);
  });
});
