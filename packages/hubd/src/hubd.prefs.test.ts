/** Per-person prefs routes: GET/PUT /v1/prefs/:key (work-wolfpack-H1OQNIh). */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";
import { seedTokens } from "./testing/tokens.js";
import { MAX_PREF_BYTES, createPrefsStore } from "./prefs.js";

let dir = "";
let hub: HubServer;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-prefs-"));
  seedTokens(dir, ["hA"]);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function device() {
  const s = createTokenStore(dir);
  return s.redeem(s.mintPairingCode({ kind: "console" }).code, "dev", "console").token;
}
const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
  fetch(hub.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("prefs routes", () => {
  it("answers null before a value is stored, then returns what any of the person's devices PUT", async () => {
    const a = device();
    const b = device();
    expect(await (await call(a, "GET", "/v1/prefs/graph.render-settings")).json()).toEqual({ value: null });
    const put = await call(a, "PUT", "/v1/prefs/graph.render-settings", { value: { nodeSize: 3 } });
    expect(put.status).toBe(200);
    expect(await (await call(b, "GET", "/v1/prefs/graph.render-settings")).json()).toEqual({ value: { nodeSize: 3 } });
  });

  it("answers 401 without a token", async () => {
    expect((await call(undefined, "GET", "/v1/prefs/x")).status).toBe(401);
    expect((await call(undefined, "PUT", "/v1/prefs/x", { value: 1 })).status).toBe(401);
  });

  it("refuses a value over the size cap and a bad key, and keeps the old value", async () => {
    const t = device();
    await call(t, "PUT", "/v1/prefs/k", { value: "small" });
    const big = await call(t, "PUT", "/v1/prefs/k", { value: "x".repeat(MAX_PREF_BYTES) });
    expect(big.status).toBe(400);
    expect((await call(t, "PUT", "/v1/prefs/bad%20key", { value: 1 })).status).toBe(400);
    expect(await (await call(t, "GET", "/v1/prefs/k")).json()).toEqual({ value: "small" });
  });
});

describe("prefs store", () => {
  it("keeps each person's values apart and leaves no temp files after a write", async () => {
    const store = createPrefsStore(dir);
    await store.put("ann", "k", { v: 1 });
    await store.put("bob", "k", { v: 2 });
    await store.put("ann", "k", { v: 3 });
    expect(await store.get("ann", "k")).toEqual({ v: 3 });
    expect(await store.get("bob", "k")).toEqual({ v: 2 });
    expect(await store.get("cy", "k")).toBeNull();
    expect(readdirSync(join(dir, "prefs", "ann"))).toEqual(["k.json"]);
  });
});
