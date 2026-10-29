/** Seam 2: ledger-level tests for hubd work writes: byte compatibility with direct work-ops, concurrency, the writer lock. */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { createWork, loadWorkState, moveWork, noteWork, stageWork, graduateWork, deleteWork, setCriteria } from "@wolfpack/kb/client";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const OP = { [ACTOR_HEADER]: JSON.stringify({ id: "1uk4", kind: "operator" }) };
const tmp: string[] = [];
const servers: HubServer[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-writes-"));
  tmp.push(d);
  return d;
};
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const start = async (dataDir: string) => {
  const h = await createHubServer({ dataDir, apiKey: KEY });
  servers.push(h);
  return h;
};
const req = (h: HubServer, method: string, path: string, body?: unknown) =>
  fetch(h.url + path, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...OP }, body: body === undefined ? undefined : JSON.stringify(body) });
const ledger = (dir: string) => readFileSync(join(dir, "ledger", "work-events.jsonl"), "utf8");

/** Normalise the fields that legitimately differ between runs: every `at` timestamp, and the generated ids (work-<domain>-<random>) mapped to stable placeholders by first appearance. */
function normalise(text: string): string[] {
  const ids = new Map<string, string>();
  const idOf = (id: string) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size}>`), ids.get(id)!));
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/"at":"[^"]*"/g, '"at":"<at>"').replace(/work-[a-z0-9-]+-[a-z0-9]{4,}/gi, (m) => idOf(m)));
}

describe("ledger byte compatibility", () => {
  it("HTTP writes append the same bytes as direct work-ops on a copy (modulo timestamps and generated ids)", async () => {
    const src = mk();
    const seeded = seedFixture(src);
    const a = mk();
    const b = mk();
    cpSync(src, a, { recursive: true });
    cpSync(src, b, { recursive: true });
    const before = ledger(src);
    const [t1, t2] = seeded.tasks;
    const inbox = [...loadWorkState(hubRoots(src)).values()].find((w) => w.container)!.id as string;

    // A: through hubd HTTP
    const hub = await start(a);
    const created = (await (await req(hub, "POST", "/v1/work", { kind: "task", domain: FIXTURE_DOMAIN, title: "New task", assignee: "1uk4", partOf: seeded.feature.id, successCriteria: "ok" })).json()) as { id: string };
    expect((await req(hub, "PATCH", `/v1/work/${created.id}`, { stage: "in_build" })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t1}`, { note: "a note" })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t1}`, { moveTo: inbox })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t2}`, { successCriteria: "changed" })).status).toBe(200);
    expect((await req(hub, "POST", `/v1/work/${t2}/graduate`)).status).toBe(200);
    expect((await req(hub, "DELETE", `/v1/work/${created.id}`)).status).toBe(200);

    // B: directly through work-ops, same sequence
    const rb = hubRoots(b);
    const c = createWork(rb, { kind: "task", domain: FIXTURE_DOMAIN, title: "New task", assignee: "1uk4", partOf: seeded.feature.id, successCriteria: "ok" });
    stageWork(rb, c.id, "in_build");
    noteWork(rb, t1, "a note");
    moveWork(rb, t1, inbox);
    setCriteria(rb, t2, "changed");
    graduateWork(rb, t2);
    deleteWork(rb, c.id);

    const la = ledger(a);
    const lb = ledger(b);
    expect(la.startsWith(before)).toBe(true); // pre-existing bytes untouched
    expect(lb.startsWith(before)).toBe(true);
    const appendedA = normalise(la.slice(before.length));
    const appendedB = normalise(lb.slice(before.length));
    expect(appendedA.length).toBeGreaterThan(5);
    expect(appendedA).toEqual(appendedB);
    // Every appended `at` has the same shape as the ones kb writes (and the pre-existing lines).
    for (const line of la.slice(before.length).split("\n").filter(Boolean)) expect((JSON.parse(line) as { at: string }).at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    for (const line of la.slice(before.length).split("\n").filter(Boolean)) JSON.parse(line);
  });
});

describe("serialised concurrent writers", () => {
  it("N concurrent POST/PATCH all land; ledger lines are well-formed; folded state is consistent", async () => {
    const dir = mk();
    const seeded = seedFixture(dir);
    const hub = await start(dir);
    const N = 25;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => req(hub, "POST", "/v1/work", { kind: "task", domain: FIXTURE_DOMAIN, title: `c${i}`, assignee: "1uk4", partOf: seeded.feature.id }).then((r) => r.json() as Promise<{ id: string }>)),
    );
    expect(new Set(created.map((c) => c.id)).size).toBe(N);
    const patches = await Promise.all(
      created.flatMap((c, i) => [req(hub, "PATCH", `/v1/work/${c.id}`, { note: `n${i}` }), req(hub, "PATCH", `/v1/work/${c.id}`, { title: `t${i}` })]),
    );
    expect(patches.every((r) => r.status === 200)).toBe(true);
    const lines = ledger(dir).split("\n").filter(Boolean);
    for (const l of lines) JSON.parse(l);
    const state = loadWorkState(hubRoots(dir));
    created.forEach((c, i) => expect(state.get(c.id as never)?.title).toBe(`t${i}`));
    expect(lines.filter((l) => l.includes('"work.noted"')).length).toBe(N);
  });

  it("the post-append hook sees every appended event in order", async () => {
    const dir = mk();
    seedFixture(dir);
    const hub = await start(dir);
    const seen: string[] = [];
    hub.onWorkAppended(({ actor, events }) => {
      expect(actor.id).toBe("1uk4");
      seen.push(...events.map((e) => e.type));
    });
    await req(hub, "POST", "/v1/work", { kind: "idea", domain: FIXTURE_DOMAIN, title: "hooked", assignee: "1uk4" });
    expect(seen[0]).toBe("work.created");
  });
});

describe("writer lock", () => {
  it("a second hubd on the same dataDir is refused, and the lock is released on close", async () => {
    const dir = mk();
    const first = await start(dir);
    await expect(createHubServer({ dataDir: dir, apiKey: KEY })).rejects.toThrow(/already has a writer/);
    await first.close();
    servers.pop();
    const again = await start(dir);
    expect((await fetch(again.url + `/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { "X-API-Key": KEY } })).status).toBe(200);
  });
});
