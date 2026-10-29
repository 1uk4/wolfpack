import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { assertedActor, createHubServer, HubError, readActor, writeActor, type HubServer } from "./server.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const dataDir = mkdtempSync(join(tmpdir(), "hubd-unit-"));
let hub: HubServer;
let seeded: ReturnType<typeof seedFixture>;
beforeAll(async () => {
  seeded = seedFixture(dataDir);
  hub = await createHubServer({ dataDir, apiKey: KEY });
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const get = (p: string, extra: Record<string, string> = {}) => fetch(hub.url + p, { headers: { "X-API-Key": KEY, ...extra } });
const actor = (a: unknown) => ({ [ACTOR_HEADER]: JSON.stringify(a) });
type Row = { id: string; container?: boolean; graduated?: string };

describe("hubd work reads", () => {
  it("the record carries the plan, record, and a feature's children", async () => {
    const rec = (await (await get(`/v1/work/${seeded.feature.id}/record`)).json()) as { plan: string; record: string; children: { id: string }[] };
    expect(rec.plan).toContain("Build it.");
    expect(rec.plan).not.toContain("Decided things");
    expect(rec.record).toBe("Decided things.");
    expect(rec.children.map((c) => c.id).sort()).toEqual([...seeded.tasks, seeded.graduated].sort());
  });

  it("lists the feature, its open tasks and the Inbox container; graduated items are hidden by default", async () => {
    const l = (await (await get(`/v1/work?domain=${FIXTURE_DOMAIN}`)).json()) as { items: Row[] };
    const ids = l.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([seeded.feature.id, ...seeded.tasks]));
    expect(ids).not.toContain(seeded.graduated);
    expect(l.items.filter((i) => i.container)).toHaveLength(1); // the domain Inbox createWork made
  });

  it("graduated=true includes graduated items, with their date", async () => {
    const l = (await (await get(`/v1/work?domain=${FIXTURE_DOMAIN}&graduated=true`)).json()) as { items: Row[] };
    expect(l.items.find((i) => i.id === seeded.graduated)?.graduated).toBe("2026-09-30");
    expect(l.items.length).toBeGreaterThan((await (await get(`/v1/work?domain=${FIXTURE_DOMAIN}`)).json() as { items: Row[] }).items.length);
  });
});

describe("hubd actor (PROVISIONAL: asserted, not proven)", () => {
  it("a valid actor header is accepted on reads", async () => {
    for (const a of [{ id: "1uk4", kind: "wolf" }, { id: "owner", kind: "operator" }]) {
      expect((await get(`/v1/work?domain=${FIXTURE_DOMAIN}`, actor(a))).status).toBe(200);
    }
  });
  it("a malformed actor, or a client asserting system, is invalid_request", async () => {
    for (const h of [{ [ACTOR_HEADER]: "nope" }, actor({ id: "", kind: "wolf" }), actor({ id: "x", kind: "root" }), actor({ id: "system", kind: "system" })]) {
      const r = await get("/v1/work?domain=x", h);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("invalid_request");
    }
  });
  it("wolf-scoped routes are not served by the hub", async () => {
    expect((await get("/v1/wolves/a/threads")).status).toBe(404);
    expect((await get("/v1/wolves")).status).toBe(200);
  });

  const req = (a?: unknown) => ({ headers: a === undefined ? {} : { [ACTOR_HEADER.toLowerCase()]: JSON.stringify(a) } });
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof HubError ? e.code : "other";
    }
    return "none";
  };
  it("reads default to the system actor; assertedActor does not", () => {
    expect(readActor(req())).toEqual({ id: "system", kind: "system" });
    expect(assertedActor(req())).toBeUndefined();
    expect(readActor(req({ id: "w", kind: "wolf" }))).toEqual({ id: "w", kind: "wolf" });
  });
  it("writeActor: an explicit actor is required; system is refused; ownerOnly needs an operator", () => {
    expect(code(() => writeActor(req()))).toBe("invalid_request");
    expect(code(() => writeActor(req({ id: "system", kind: "system" })))).toBe("invalid_request");
    expect(writeActor(req({ id: "w", kind: "wolf" }))).toEqual({ id: "w", kind: "wolf" });
    expect(code(() => writeActor(req({ id: "w", kind: "wolf" }), { ownerOnly: true }))).toBe("forbidden");
    expect(code(() => writeActor(req(), { ownerOnly: true }))).toBe("invalid_request");
    expect(writeActor(req({ id: "me", kind: "operator" }), { ownerOnly: true })).toEqual({ id: "me", kind: "operator" });
  });
});

describe("hubd internal errors", () => {
  it("answers a generic engine_error and keeps the detail server-side", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-broken-"));
    mkdirSync(join(dir, "ledger", "work-events.jsonl"), { recursive: true }); // a directory where the ledger file should be: reads throw
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await createHubServer({ dataDir: dir, apiKey: KEY });
    try {
      const r = await fetch(`${broken.url}/v1/work?domain=x`, { headers: { "X-API-Key": KEY } });
      expect(r.status).toBe(502);
      const env = (await r.json()) as { code: string; message: string };
      expect(env.code).toBe("engine_error");
      expect(env.message).toBe("internal hub error");
      expect(env.message).not.toMatch(/EISDIR|work-events|hubd-broken/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await broken.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
