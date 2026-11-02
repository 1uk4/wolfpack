/** The hub-proxied Work API (work-proxy.ts): shapes of the agent's /work routes, whitelist, and worker-token scoping. */
import { mkdtempSync, rmSync } from "node:fs";
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

  it("an operator token is unrestricted over the whitelist", async () => {
    const { call, A } = await rig();
    const id = ((await (await call(A, "POST", "", feature)).json()) as { id: string }).id;
    expect((await call(OP_TOKEN, "GET", `/${id}`)).status).toBe(200);
    expect((await call(OP_TOKEN, "GET", "")).status).toBe(200);
  });
});
