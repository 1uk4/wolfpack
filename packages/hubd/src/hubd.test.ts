import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHubServer, type HubServer } from "./server.js";
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

describe("hubd work reads", () => {
  it("the record carries the plan, record, and a feature's children", async () => {
    const rec = (await (await get(`/v1/work/${seeded.feature.id}/record`)).json()) as { plan: string; record: string; children: { id: string }[] };
    expect(rec.plan).toContain("Build it.");
    expect(rec.plan).not.toContain("Decided things");
    expect(rec.record).toBe("Decided things.");
    expect(rec.children.map((c) => c.id).sort()).toEqual([...seeded.tasks].sort());
  });
  it("lists the fixture items incl. the inbox container", async () => {
    const l = (await (await get(`/v1/work?domain=${FIXTURE_DOMAIN}`)).json()) as { items: { id: string; container?: boolean }[] };
    expect(l.items.length).toBeGreaterThanOrEqual(3);
  });
  it("rejects a malformed actor header and wolf-scoped routes", async () => {
    expect((await get("/v1/work?domain=x", { "X-Wolfpack-Actor": "nope" })).status).toBe(400);
    expect((await get("/v1/wolves/a/threads")).status).toBe(404);
    expect((await get("/v1/wolves")).status).toBe(200);
  });
});
