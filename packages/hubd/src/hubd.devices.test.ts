/** Device management routes: GET /v1/tokens, DELETE /v1/tokens/:id, POST /v1/tokens/pairing-codes (auth, no secrets, revoke, rate limit). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedFixture } from "./testing/fixture.js";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";

let dir = "";
let clock = Date.now();
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-devices-"));
  seedFixture(dir);
  clock = Date.now();
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 50, now: () => clock });
  store = createTokenStore(dir, () => clock);
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function device(kind: "console" | "browser" | "worker", label: string) {
  const { code } = store.mintPairingCode({ kind, label, ...(kind === "worker" ? { hostId: "vps-1" } : {}) });
  const r = await fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label }) });
  expect(r.status).toBe(200);
  return (await r.json()) as { token: string; tokenId: string };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const list = (t: string) => fetch(`${hub.url}/v1/tokens`, { headers: auth(t) });

describe("device management routes", () => {
  it("401 without a valid token on all three routes", async () => {
    for (const [m, p] of [["GET", "/v1/tokens"], ["DELETE", "/v1/tokens/tok-x"], ["POST", "/v1/tokens/pairing-codes"]] as const) {
      expect((await fetch(`${hub.url}${p}`, { method: m })).status, p).toBe(401);
      expect((await fetch(`${hub.url}${p}`, { method: m, headers: auth("nope") })).status, p).toBe(401);
    }
  });

  it("a worker token is forbidden on all three routes", async () => {
    const w = await device("worker", "vps");
    expect((await list(w.token)).status).toBe(403);
    expect((await fetch(`${hub.url}/v1/tokens/${w.tokenId}`, { method: "DELETE", headers: auth(w.token) })).status).toBe(403);
    expect((await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: auth(w.token) })).status).toBe(403);
  });

  it("lists console/browser devices with self and lastUsedAt, never a secret, hash or worker token", async () => {
    const a = await device("browser", "Phone");
    const b = await device("console", "Laptop");
    const w = await device("worker", "vps");
    const r = await list(a.token);
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const secret of [a.token, b.token, w.token]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/hash/i);
    const { devices } = JSON.parse(text) as { devices: { id: string; label: string; self: boolean; createdAt: string; lastUsedAt: string | null }[] };
    expect(devices.map((d) => d.label).sort()).toEqual(["Laptop", "Phone"]);
    expect(devices.find((d) => d.id === a.tokenId)).toMatchObject({ self: true, label: "Phone" });
    expect(devices.find((d) => d.id === b.tokenId)!.self).toBe(false);
    expect(devices.find((d) => d.id === w.tokenId)).toBeUndefined();
    expect(devices.find((d) => d.id === a.tokenId)!.lastUsedAt).toMatch(/^\d{4}-/); // this very request touched it
  });

  it("revokes another device: its next request is 401, the caller keeps working", async () => {
    const a = await device("browser", "A");
    const b = await device("browser", "B");
    expect((await list(b.token)).status).toBe(200);
    const r = await fetch(`${hub.url}/v1/tokens/${b.tokenId}`, { method: "DELETE", headers: auth(a.token) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revoked: b.tokenId, self: false });
    expect((await list(b.token)).status).toBe(401);
    expect((await list(a.token)).status).toBe(200);
  });

  it("a device may revoke itself; unknown ids and worker token ids are 404", async () => {
    const a = await device("browser", "A");
    const w = await device("worker", "vps");
    expect((await fetch(`${hub.url}/v1/tokens/tok-nope`, { method: "DELETE", headers: auth(a.token) })).status).toBe(404);
    expect((await fetch(`${hub.url}/v1/tokens/${w.tokenId}`, { method: "DELETE", headers: auth(a.token) })).status).toBe(404);
    expect((await fetch(`${hub.url}/v1/work?domain=x`, { headers: auth(w.token) })).status).not.toBe(401); // worker still valid
    const r = await fetch(`${hub.url}/v1/tokens/${a.tokenId}`, { method: "DELETE", headers: auth(a.token) });
    expect(await r.json()).toEqual({ revoked: a.tokenId, self: true });
    expect((await list(a.token)).status).toBe(401);
  });

  it("revoking closes that device's event stream", async () => {
    const a = await device("browser", "A");
    const b = await device("browser", "B");
    const ac = new AbortController();
    const ev = await fetch(`${hub.url}/v1/events`, { headers: auth(b.token), signal: ac.signal });
    expect(ev.status).toBe(200);
    const reader = ev.body!.getReader();
    await fetch(`${hub.url}/v1/tokens/${b.tokenId}`, { method: "DELETE", headers: auth(a.token) });
    const end = await Promise.race([
      (async () => { for (;;) { const { done } = await reader.read().catch(() => ({ done: true })); if (done) return "closed"; } })(),
      new Promise((res) => setTimeout(() => res("open"), 3000)),
    ]);
    ac.abort();
    expect(end).toBe("closed");
  });

  it("mints a single-use browser pairing code that redeems into a listed device", async () => {
    const a = await device("browser", "A");
    const r = await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: { ...auth(a.token), "Content-Type": "application/json" }, body: JSON.stringify({ label: "Tablet" }) });
    expect(r.status).toBe(200);
    const { code, expiresAt } = (await r.json()) as { code: string; expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(clock);
    const p = await fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "ignored" }) });
    expect(p.status).toBe(200);
    expect((await fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "x" }) })).status).toBe(401);
    const { devices } = (await (await list(a.token)).json()) as { devices: { label: string }[] };
    expect(devices.map((d) => d.label)).toContain("Tablet");
    // no body at all also works
    expect((await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: auth(a.token) })).status).toBe(200);
  });

  it("rate-limits mints and revokes per token (10 a minute), then recovers", async () => {
    const a = await device("browser", "A");
    for (let i = 0; i < 10; i++) expect((await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: auth(a.token) })).status).toBe(200);
    const r = await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: auth(a.token) });
    expect(r.status).toBe(409);
    expect((await r.json()).retryable).toBe(true);
    clock += 61_000;
    expect((await fetch(`${hub.url}/v1/tokens/pairing-codes`, { method: "POST", headers: auth(a.token) })).status).toBe(200);
  });
});
