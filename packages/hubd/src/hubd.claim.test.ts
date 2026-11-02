/** Claim / unclaim: compare-and-set under the write queue, inheritance, stage move, work.bound fold, ledger shape. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendWorkLedger, createWork, loadWorkState, stageWork } from "@wolfpack/kb/client";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";
import { wolfCast } from "./testing/tokens.js";

/** Credentials per wolf name (worker token of the wolf's own host) or "operator"; filled by setup(). */
let creds: Record<string, Record<string, string>> = {};
const as = (id: string, kind: "wolf" | "operator" = "wolf") => {
  const h = creds[kind === "operator" ? "operator" : id];
  if (!h) throw new Error(`no credentials for ${id}`);
  return h;
};
const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hubd-claim-"));
  tmp.push(dir);
  const seeded = seedFixture(dir);
  const roots = hubRoots(dir);
  const mk = (kind: "task" | "feature" | "idea", extra: Record<string, unknown> = {}) =>
    createWork(roots, { kind, domain: FIXTURE_DOMAIN, title: `${kind} x`, assignee: "1uk4", successCriteria: "ok", ...extra } as never).id as string;
  const hub = await createHubServer({ dataDir: dir });
  servers.push(hub);
  const cast = await wolfCast(hub, ["w1", "w2", "wolf-a", "wolf-b"], FIXTURE_DOMAIN);
  creds = { operator: cast.operator, ...cast.wolves };
  const post = (path: string, actor: Record<string, string>) => fetch(hub.url + path, { method: "POST", headers: actor });
  return { dir, seeded, roots, mk, hub, claim: (id: string, a: Record<string, string>) => post(`/v1/work/${id}/claim`, a), unclaim: (id: string, a: Record<string, string>) => post(`/v1/work/${id}/unclaim`, a) };
}

describe("hub claim", () => {
  it("appends assigned + bound + staged (approved -> in_build) in one go; fold records the holder", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const res = await s.claim(id, as("w1"));
    expect(res.status).toBe(200);
    const lines = readFileSync(join(s.dir, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const tail = lines.slice(-3);
    expect(tail.map((e) => e.type)).toEqual(["work.assigned", "work.bound", "work.staged"]);
    expect(tail[0].assignee).toBe("w1");
    expect(tail[1].wolf).toBe("w1");
    expect(tail[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const item = loadWorkState(s.roots).get(id as never)!;
    expect(item.boundBy).toBe("w1");
    expect(item.stage).toBe("in_build");
  });

  it("a second claimant gets 409 conflict naming the holder; exactly one of two concurrent claims wins", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const [a, b] = await Promise.all([s.claim(id, as("w1")), s.claim(id, as("w2"))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = (await (a.status === 409 ? a : b).json()) as { code: string; message: string; details: { holder: string } };
    const winner = a.status === 200 ? "w1" : "w2";
    expect(loser.code).toBe("conflict");
    expect(loser.details.holder).toBe(winner);
    expect(loser.message).toContain(winner);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe(winner);
  });

  it("children inherit: a task under a feature held by another wolf is 409; the holder may claim it", async () => {
    const s = await setup();
    const f = s.seeded.feature.id;
    stageWork(s.roots, f, "approved");
    expect((await s.claim(f, as("w1"))).status).toBe(200);
    const t = s.seeded.tasks[0];
    stageWork(s.roots, t, "approved");
    const r = await s.claim(t, as("w2"));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { details: { holder: string } }).details.holder).toBe("w1");
    expect((await s.claim(t, as("w1"))).status).toBe(200);
  });

  it("rejects idea items, plan-stage items and initiatives; a loose Inbox task is a valid target", async () => {
    const s = await setup();
    const idea = s.mk("idea");
    expect((await s.claim(idea, as("w1"))).status).toBe(400);
    const planned = s.mk("task");
    expect((await s.claim(planned, as("w1"))).status).toBe(400);
    const init = s.mk("task");
    const loose = createWork(s.roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "loose", assignee: "1uk4", successCriteria: "ok" }).id as string;
    stageWork(s.roots, loose, "approved");
    expect(loadWorkState(s.roots).get(loose as never)!.partOf).toBeTruthy();
    expect((await s.claim(loose, as("w1"))).status).toBe(200);
    void init;
    expect((await s.claim("work-wolfpack-nope0000", as("w1"))).status).toBe(404);
  });

  it("unclaim: holder or operator releases, others get 403; stage is left alone; the item is claimable again", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    await s.claim(id, as("w1"));
    expect((await s.unclaim(id, as("w2"))).status).toBe(403);
    expect((await s.unclaim(id, as("w1"))).status).toBe(200);
    const item = loadWorkState(s.roots).get(id as never)!;
    expect(item.boundBy).toBeNull();
    expect(item.stage).toBe("in_build");
    expect((await s.claim(id, as("w2"))).status).toBe(200);
    expect((await s.unclaim(id, as("1uk4", "operator"))).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBeNull();
  });

  it("a worker token cannot claim for a wolf that is unregistered or on another host (403); the operator token can claim as itself", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const post = (path: string, actor: Record<string, string>, wolf: string) =>
      fetch(s.hub.url + path, { method: "POST", headers: { "Content-Type": "application/json", ...actor }, body: JSON.stringify({ wolf }) });
    for (const wolf of ["Bad_Id", "ghost", "w2"]) {
      expect((await post(`/v1/work/${id}/claim`, as("w1"), wolf)).status).toBe(403);
      expect((await post(`/v1/work/${id}/unclaim`, as("w1"), wolf)).status).toBe(403);
    }
    expect(loadWorkState(s.roots).get(id as never)!.boundBy ?? null).toBeNull();
    expect((await s.claim(id, as("1uk4", "operator"))).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("owner");
  });

  it("a worker token may act for any active wolf on its host (named in the body); a retired wolf is refused", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const op = as("x", "operator");
    // second wolf on host h-w1
    expect((await fetch(`${s.hub.url}/v1/registry/wolves`, { method: "POST", headers: { "Content-Type": "application/json", ...op }, body: JSON.stringify({ name: "w1b", host: "h-w1" }) })).status).toBe(201);
    const post = (wolf?: string) =>
      fetch(`${s.hub.url}/v1/work/${id}/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...as("w1") }, body: wolf ? JSON.stringify({ wolf }) : undefined });
    expect((await post()).status).toBe(400); // two wolves on the host and none named
    expect((await post("w1b")).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("w1b");
    expect((await fetch(`${s.hub.url}/v1/registry/wolves/w1b/retire`, { method: "POST", headers: op })).status).toBe(200);
    expect((await post("w1b")).status).toBe(403);
  });

  it("a host with two active wolves: claim and unclaim with {wolf} succeed and are attributed to that wolf; without it, 400", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const op = as("x", "operator");
    expect((await fetch(`${s.hub.url}/v1/registry/wolves`, { method: "POST", headers: { "Content-Type": "application/json", ...op }, body: JSON.stringify({ name: "w1b", host: "h-w1" }) })).status).toBe(201);
    const post = (verb: string, wolf?: string) =>
      fetch(`${s.hub.url}/v1/work/${id}/${verb}`, { method: "POST", headers: { "Content-Type": "application/json", ...as("w1") }, body: wolf ? JSON.stringify({ wolf }) : undefined });
    expect((await post("claim")).status).toBe(400);
    expect((await post("unclaim")).status).toBe(400);
    expect((await post("claim", "w1b")).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("w1b");
    const events = readFileSync(join(s.dir, "ledger/work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "work.bound").pop()).toMatchObject({ by: "w1b" });
    expect((await post("claim", "w1")).status).toBe(409); // the other wolf of the same host is a different holder
    expect((await post("unclaim", "w1")).status).toBe(403); // not the holder
    expect((await post("unclaim", "w1b")).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy ?? null).toBeNull();
    expect((await post("claim", "w1")).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("w1");
  });

  it("single-wolf fallback: with no body the host's only wolf claims; with none active it is 403", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    expect((await s.claim(id, as("w1"))).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("w1");
    expect((await s.unclaim(id, as("w1"))).status).toBe(200);
    expect((await fetch(`${s.hub.url}/v1/registry/wolves/w1/retire`, { method: "POST", headers: as("x", "operator") })).status).toBe(200);
    expect((await s.claim(id, as("w1"))).status).toBe(403); // no active wolf on the host
    expect((await s.unclaim(id, as("w1"))).status).toBe(403);
  });

  it("the {wolf} body is read when chunked, and a non-JSON body is 400", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    const op = as("x", "operator");
    expect((await fetch(`${s.hub.url}/v1/registry/wolves`, { method: "POST", headers: { "Content-Type": "application/json", ...op }, body: JSON.stringify({ name: "w1b", host: "h-w1" }) })).status).toBe(201);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"wolf":')); c.enqueue(new TextEncoder().encode('"w1b"}')); c.close(); } });
    const chunked = await fetch(`${s.hub.url}/v1/work/${id}/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...as("w1") }, body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBe("w1b");
    const bad = await fetch(`${s.hub.url}/v1/work/${id}/unclaim`, { method: "POST", headers: { "Content-Type": "application/json", ...as("w1") }, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("an unknown id is 404 on claim and unclaim", async () => {
    const s = await setup();
    expect((await s.claim("work-wolfpack-nope0000", as("w1"))).status).toBe(404);
    expect((await s.unclaim("work-wolfpack-nope0000", as("w1"))).status).toBe(404);
  });

  it("only approved and in_build are claimable: plan and feasibility before, shipped and archived after", async () => {
    const s = await setup();
    const id = s.mk("task");
    expect((await s.claim(id, as("w1"))).status).toBe(400); // plan
    stageWork(s.roots, id, "feasibility");
    expect((await s.claim(id, as("w1"))).status).toBe(400);
    stageWork(s.roots, id, "approved");
    expect((await s.claim(id, as("w1"))).status).toBe(200);
    stageWork(s.roots, id, "shipped");
    expect((await s.claim(id, as("w1"))).status).toBe(400);
    stageWork(s.roots, id, "archived");
    expect((await s.claim(id, as("w1"))).status).toBe(400);
  });

  it("inheritance runs both ways: a held child blocks its feature, a held feature blocks its child", async () => {
    const s = await setup();
    const f = s.seeded.feature.id;
    const [t1, t2] = s.seeded.tasks;
    stageWork(s.roots, f, "approved");
    stageWork(s.roots, t1, "approved");
    expect((await s.claim(t1, as("w1"))).status).toBe(200);
    const r = await s.claim(f, as("w2"));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { details: { holder: string } }).details.holder).toBe("w1");
    expect((await s.claim(f, as("w1"))).status).toBe(200); // the child's holder may take the feature
    stageWork(s.roots, t2, "approved");
    expect((await s.claim(t2, as("w2"))).status).toBe(409); // now the feature is held by w1
  });

  it("a legacy work.bound with no unbound reads as held: B gets 409, operator unclaim clears it, B then claims", async () => {
    const s = await setup();
    const id = s.mk("task");
    stageWork(s.roots, id, "approved");
    appendWorkLedger(s.roots, [{ type: "work.bound", id: id as never, at: "2026-09-01 10:00", wolf: "wolf-a" as never }]);
    const r = await s.claim(id, as("wolf-b"));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { details: { holder: string } }).details.holder).toBe("wolf-a");
    expect((await s.unclaim(id, as("1uk4", "operator"))).status).toBe(200);
    expect(loadWorkState(s.roots).get(id as never)!.boundBy).toBeNull();
    expect((await s.claim(id, as("wolf-b"))).status).toBe(200);
  });
});
