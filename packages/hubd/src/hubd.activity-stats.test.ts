import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryBus } from "./activity/bus.js";
import { createActivityDeriver } from "./activity/derive.js";
import { createPresenceStore } from "./activity/presence.js";
import { createActivityStats } from "./activity/stats.js";
import { createHubServer, type HubOptions, type HubServer } from "./server.js";
import { seedFixture } from "./testing/fixture.js";
import { OP, registerWolfOnHost, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function start(extra: Partial<HubOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-activity-stats-"));
  tmp.push(dir);
  seedFixture(dir);
  seedTokens(dir);
  const h = await createHubServer({ dataDir: dir, ...extra });
  servers.push(h);
  const w1 = await registerWolfOnHost(h, OP, "w1", "h1");
  await registerWolfOnHost(h, OP, "w2", "h2");
  return { h, w1 };
}
const ev = (wolf: string, over: Record<string, unknown> = {}) => ({ v: 1, id: `e${Math.random()}`, pack: "", ts: 1, ttlMs: 60_000, actor: { kind: "wolf", wolf }, verb: "wolf-online", ...over });
const post = (h: HubServer, headers: Record<string, string>, events: unknown[]) =>
  fetch(h.url + "/v1/activity", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, events }) });

describe("GET /v1/activity/stats", () => {
  it("counts accepted, rejected by reason and rate-limited events per wolf, for owner/device tokens only", async () => {
    const { h, w1 } = await start({ activityBurst: 3, activityRatePerSec: 0.001 });
    await post(h, w1, [ev("w1"), ev("w2"), ev("w1", { verb: "no-such-verb" }), ev("w1"), ev("w1"), ev("w1")]);
    const r = await fetch(h.url + "/v1/activity/stats", { headers: OP });
    expect(r.status).toBe(200);
    const s = (await r.json()) as { wolves: Record<string, { accepted: number; rejected: Record<string, number>; rateLimited: number }> };
    expect(s.wolves.w1).toMatchObject({ accepted: 2, rejected: { invalid: 1 }, rateLimited: 2 });
    expect(s.wolves.w2).toMatchObject({ accepted: 0, rejected: { spoofed: 1 } });
    expect((await fetch(h.url + "/v1/activity/stats", { headers: w1 })).status).toBe(403);
    expect((await fetch(h.url + "/v1/activity/stats")).status).toBe(401);
  });
});

describe("activity stats", () => {
  it("keeps at most 200 wolves, folding the rest into one overflow row without losing the totals", () => {
    const st = createActivityStats({ maxWolves: 200 });
    for (let i = 0; i < 500; i++) st.add(`w${i}`, "accepted");
    const w = st.snapshot("p", 0).wolves;
    expect(Object.keys(w).length).toBeLessThanOrEqual(200);
    expect(Object.values(w).reduce((n, x) => n + x.accepted, 0)).toBe(500);
  });

  it("derive counts published events and queue drops per actor, and caps its queue", async () => {
    const st = createActivityStats();
    const d = createActivityDeriver({ bus: createMemoryBus(), presence: createPresenceStore(), pack: "p", stats: st, queueMax: 5 });
    const events = Array.from({ length: 12 }, (_, i) => ({ type: "work.staged", id: `work-personal-Ab${i}aaaa`, to: "shipped" }));
    d.run({}, () => d.onLedger({ actor: { id: "owner", kind: "operator" }, events }));
    await new Promise((r) => setTimeout(r, 30));
    expect(st.snapshot("p", 0).wolves.owner).toMatchObject({ derivedPublished: 5, queueDropped: 7 });
  });
});
