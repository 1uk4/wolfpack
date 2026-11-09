import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeHealth } from "@wolfpack/protocol";
import { healthShapeProblems } from "@wolfpack/protocol/stub";
import { assertedActor, createHubServer, HubError, readActor, writeActor, type HubServer } from "./server.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";
import { bearer, mintOperatorToken } from "./testing/tokens.js";

let auth: Record<string, string> = {};
const dataDir = mkdtempSync(join(tmpdir(), "hubd-unit-"));
let hub: HubServer;
let seeded: ReturnType<typeof seedFixture>;
beforeAll(async () => {
  seeded = seedFixture(dataDir);
  hub = await createHubServer({ dataDir });
  auth = bearer(mintOperatorToken(dataDir));
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const get = (p: string, extra: Record<string, string> = {}) => fetch(hub.url + p, { headers: { ...auth, ...extra } });
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

describe("hubd actor (the token's identity; nothing a client sends can assert one)", () => {
  it("an X-Wolfpack-Actor header, valid, malformed or asserting system, is ignored", async () => {
    for (const v of [JSON.stringify({ id: "1uk4", kind: "wolf" }), "nope", JSON.stringify({ id: "system", kind: "system" })]) {
      expect((await get(`/v1/work?domain=${FIXTURE_DOMAIN}`, { "X-Wolfpack-Actor": v })).status).toBe(200);
    }
  });
  it("wolf-scoped routes are not served by the hub", async () => {
    expect((await get("/v1/wolves/a/threads")).status).toBe(404);
    expect((await get("/v1/wolves")).status).toBe(200);
  });

  const req = () => ({ headers: { "x-wolfpack-actor": JSON.stringify({ id: "w", kind: "wolf" }) } });
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof HubError ? e.code : "other";
    }
    return "none";
  };
  it("a request with no verified token has no actor, whatever its headers say", () => {
    expect(readActor(req())).toEqual({ id: "system", kind: "system" });
    expect(assertedActor(req())).toBeUndefined();
  });
  it("writeActor needs an authenticated token (the actor header never counts)", () => {
    expect(code(() => writeActor(req()))).toBe("invalid_request");
    expect(code(() => writeActor(req(), { ownerOnly: true }))).toBe("invalid_request");
  });
});

describe("hubd /healthz", () => {
  it("answers without a token with service, version, uptime and event-loop lag", async () => {
    const res = await fetch(hub.url + "/healthz");
    expect(res.status).toBe(200);
    expect(healthShapeProblems(await res.json(), "hubd", `${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}-dev`)).toEqual([]); // unstamped checkout: <package.json>-dev
  });

  it("a frozen event loop shows as lag on every probe in the window, graded degraded", async () => {
    await new Promise((r) => setTimeout(r, 50)); // let the monitor tick normally first
    const t = Date.now();
    while (Date.now() - t < 300) {
      /* freeze the loop hubd serves on (same process) */
    }
    const first = await probeHealth(hub.url + "/healthz", { expectService: "hubd" });
    const second = await probeHealth(hub.url + "/healthz", { expectService: "hubd" });
    for (const r of [first, second]) {
      expect((r.body?.lag as { maxMs: number }).maxMs).toBeGreaterThanOrEqual(200); // the second probe still sees the spike: reading never resets the window
      expect(r.status).toBe("degraded");
    }
  });
});

describe("hubd internal errors", () => {
  it("answers a generic engine_error and keeps the detail server-side", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-broken-"));
    mkdirSync(join(dir, "ledger", "work-events.jsonl"), { recursive: true }); // a directory where the ledger file should be: reads throw
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await createHubServer({ dataDir: dir });
    try {
      const r = await fetch(`${broken.url}/v1/work?domain=x`, { headers: bearer(mintOperatorToken(dir)) });
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
