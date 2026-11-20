/** Owner approvals (work-approvals.ts): a worker token files a request; only a non-worker token decides it. */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubServer as createRaw, type HubServer } from "./server.js";
import { setWorkStoreProbe } from "./work-writes.js";
import { OP, OP_TOKEN, seedTokens, workerTokenFor } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const startHub = async (dataDir: string) => {
  const hub = await createRaw({ dataDir });
  servers.push(hub);
  return hub;
};
async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "hubd-appr-"));
  tmp.push(dataDir);
  seedTokens(dataDir, ["hA"]);
  const hub = await startHub(dataDir);
  const reg = (p: string, b: unknown) => fetch(hub.url + p, { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify(b) });
  await reg("/v1/registry/domains", { name: "personal" });
  await reg("/v1/registry/hosts", { name: "hA" });
  await reg("/v1/registry/wolves", { name: "wa", host: "hA", domains: ["personal"] });
  await reg("/v1/registry/wolves", { name: "wb", host: "hA", domains: ["personal"] });
  const W = workerTokenFor("hA");
  const api = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${hub.url}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const work = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${hub.url}/v1/workapi/work${path}`, { method, headers: { "X-API-Key": key, "X-Wolf": "wa", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const id = ((await (await work(OP_TOKEN, "POST", "", { kind: "feature", domain: "personal", title: "F", assignee: "wa", body: "x" })).json()) as { id: string }).id;
  const record = async () => ((await (await api(OP_TOKEN, "GET", `/v1/work/${id}/record`)).json()) as { record?: string; body?: string }) ;
  const item = async () => ((await (await work(OP_TOKEN, "GET", `/${id}`)).json()) as { item: { stage: string; assignee: string; graduated?: string } }).item;
  const file = (body: unknown) => api(W, "POST", `/v1/work/${id}/requests`, { wolf: "wa", ...(body as object) });
  return { dataDir, hub, api, work, W, id, record, item, file };
}
type Req = { request: { id: string; status: string; kind: string; requestedBy: { wolf: string } } };
const preview = { contributions: [{ id: "t1", title: "T", summary: "s", body: "Body one", initiative: false, history: [] }, { id: "t2", title: "U", summary: "s2", body: "Body two", initiative: false, history: [] }] };

describe("owner approvals", () => {
  it("a wolf direct graduate, archive and reassign are refused with request_forbidden", async () => {
    const r = await rig();
    for (const [m, p, b] of [["POST", `/${r.id}/graduate`, undefined], ["PATCH", `/${r.id}`, { stage: "archived" }], ["PATCH", `/${r.id}`, { assignee: "wb" }]] as const) {
      const x = await r.work(r.W, m, p, b);
      expect(x.status).toBe(403);
      expect(await x.json()).toMatchObject({ code: "request_forbidden", error: "file an approval request (POST /work/:id/requests)" });
    }
    expect((await r.item()).stage).not.toBe("archived");
  });

  it("files a request (201), refuses a second while pending (409 request_pending with the id), and a worker cannot decide or list", async () => {
    const r = await rig();
    const a = await r.file({ kind: "archive" });
    expect(a.status).toBe(201);
    const first = ((await a.json()) as Req).request;
    expect(first).toMatchObject({ status: "pending", kind: "archive", requestedBy: { wolf: "wa" } });
    const b = await r.file({ kind: "reassign", target: "wb" });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ code: "request_pending", details: { requestId: first.id } });
    for (const p of [`/v1/work/requests/${first.id}/approve`, `/v1/work/requests/${first.id}/reject`]) {
      const x = await r.api(r.W, "POST", p);
      expect(x.status).toBe(403);
      expect(((await x.json()) as { code: string }).code).toBe("request_forbidden");
    }
    expect((await r.api(r.W, "GET", "/v1/work/requests")).status).toBe(403);
    expect((await r.item()).stage).not.toBe("archived");
  });

  it("approving an archive writes the audit line to the Record before archiving, and marks the request approved", async () => {
    const r = await rig();
    const q = ((await (await r.file({ kind: "archive" })).json()) as Req).request;
    const ok = await r.api(OP_TOKEN, "POST", `/v1/work/requests/${q.id}/approve`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Req).request).toMatchObject({ status: "approved", decidedBy: { device: "tok-test-operator" } });
    expect((await r.item()).stage).toBe("archived");
    const rec = JSON.stringify(await r.record());
    expect(rec).toContain("Approved by");
    expect(rec).toContain("on device tok-test-operator");
    expect(rec).toContain("stage archived");
    expect(((await (await r.api(OP_TOKEN, "GET", "/v1/work/requests")).json()) as { requests: unknown[] }).requests).toEqual([]); // no longer pending
  });

  it("approving a graduate sends the stored preview set and graduates; approving a reassign assigns", async () => {
    const r = await rig();
    const q = ((await (await r.file({ kind: "graduate", preview })).json()) as Req).request;
    expect((await r.api(OP_TOKEN, "POST", `/v1/work/requests/${q.id}/approve`)).status).toBe(200);
    expect((await r.item()).graduated).toBeTruthy();
    expect(JSON.stringify(await r.record())).toContain("sent: 2 contributions");
    const inbox = join(r.dataDir, "kb", "ops", "contributions", "wa");
    const sent = existsSync(inbox) ? readdirSync(inbox).filter((f) => !f.startsWith(".")) : [];
    expect(sent.length).toBe(2);
  });

  it("approving a reassign changes the assignee", async () => {
    const r = await rig();
    const q = ((await (await r.file({ kind: "reassign", target: "wb" })).json()) as Req).request;
    expect((await r.api(OP_TOKEN, "POST", `/v1/work/requests/${q.id}/approve`)).status).toBe(200);
    expect((await r.item()).assignee).toBe("wb");
  });

  it("reject clears the pending request without acting, and a new one can be filed", async () => {
    const r = await rig();
    const q = ((await (await r.file({ kind: "archive" })).json()) as Req).request;
    const x = await r.api(OP_TOKEN, "POST", `/v1/work/requests/${q.id}/reject`);
    expect(((await x.json()) as Req).request.status).toBe("rejected");
    expect((await r.item()).stage).not.toBe("archived");
    expect((await r.file({ kind: "archive" })).status).toBe(201);
  });

  it("a pending request survives a hub restart", async () => {
    const r = await rig();
    const q = ((await (await r.file({ kind: "archive" })).json()) as Req).request;
    await servers.pop()!.close();
    const hub2 = await startHub(r.dataDir);
    const got = await fetch(`${hub2.url}/v1/work/requests/${q.id}`, { headers: OP });
    expect(((await got.json()) as Req).request).toMatchObject({ id: q.id, status: "pending" });
  });

  it("a read-only work store refuses to file a request", async () => {
    const r = await rig();
    restores.push(setWorkStoreProbe(() => { throw Object.assign(new Error("EROFS: injected"), { code: "EROFS" }); }));
    const x = await r.file({ kind: "archive" });
    expect(x.status).toBeGreaterThanOrEqual(500);
    restores.pop()!();
    expect((await r.api(OP_TOKEN, "GET", "/v1/work/requests")).status).toBe(200);
  });
});
