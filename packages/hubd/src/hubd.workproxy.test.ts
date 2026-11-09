/** The hub-proxied Work API (work-proxy.ts): shapes of the agent's /work routes, whitelist, and worker-token scoping. */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubServer as createRaw, type HubServer } from "./server.js";
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
  const call = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const A = workerTokenFor("hA");
  const B = workerTokenFor("hB");
  return { hub, call, A, B };
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
    // B (host hB, domain other): the item is absent for it
    expect((await call(B, "GET", `/${mine}`)).status).toBe(404);
    expect(((await (await call(B, "GET", "")).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await call(B, "PATCH", `/${mine}`, { note: "x" })).status).toBe(404);
    expect((await call(B, "POST", `/${mine}/graduate`)).status).toBe(404);
    // create: foreign assignee, foreign domain
    expect((await call(A, "POST", "", { ...feature, assignee: "wb" })).status).toBe(403);
    expect((await call(A, "POST", "", { ...feature, domain: "other" })).status).toBe(403);
    // an item in A's domain assigned to a wolf A does not own is read-only to A
    const op = ((await (await call(OP_TOKEN, "POST", "", { ...feature, assignee: "wb" })).json()) as { id: string }).id;
    expect((await call(A, "GET", `/${op}`)).status).toBe(200);
    expect((await call(A, "PATCH", `/${op}`, { note: "x" })).status).toBe(403);
    expect((await call(A, "POST", `/${op}/graduate`)).status).toBe(403);
  });

  it("whitelist: no DELETE, no assignee changes, no unknown paths; malformed ids and bodies are 400", async () => {
    const { call, A, hub } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(A, "DELETE", `/${id}`)).status).toBe(400);
    expect((await call(A, "PATCH", `/${id}`, { assignee: "wa" })).status).toBe(403);
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

  it("an operator token is unrestricted over the whitelist", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(OP_TOKEN, "GET", `/${id}`)).status).toBe(200);
    expect((await call(OP_TOKEN, "GET", "")).status).toBe(200);
  });
});
