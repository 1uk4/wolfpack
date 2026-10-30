/** Token auth: bearer required, identity from the token (forged actor ignored), pairing, revocation (incl. SSE close), CLI, legacy key. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";
import { main } from "./cli.js";
import { createTokenStore, PAIRING_TTL_MS } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";

let dir = "";
let featureId = "";
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;
const KEY = "legacy-key-0123456789";
const asOp = JSON.stringify({ id: "forged-operator", kind: "operator" });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-auth-"));
  featureId = seedFixture(dir).feature.id;
  hub = await createHubServer({ dataDir: dir, apiKey: KEY, port: 0, authPollMs: 50 });
  store = createTokenStore(dir);
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const pairVia = async (body: Record<string, unknown>, code = store.mintPairingCode().code) =>
  fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, ...body }) });
async function mint(kind: "console" | "worker" | "browser", extra: Record<string, unknown> = {}) {
  const r = await pairVia({ label: "dev", kind, ...extra });
  expect(r.status).toBe(200);
  return (await r.json()) as { token: string; tokenId: string };
}
const bearer = (t: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${t}`, ...extra });
const createWork = (headers: Record<string, string>) =>
  fetch(`${hub.url}/v1/work`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ kind: "task", domain: FIXTURE_DOMAIN, title: "t", assignee: "1uk4", partOf: featureId, successCriteria: "ok" }) });

describe("hubd token auth", () => {
  it("401 for a missing, malformed or unknown token on every route (pair excepted)", async () => {
    for (const h of [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }, { "X-API-Key": "wrong-wrong-wrong-1" }]) {
      const r = await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: h });
      expect(r.status).toBe(401);
      expect((await r.json()).code).toBe("unauthorized");
    }
    expect((await fetch(`${hub.url}/v1/events`)).status).toBe(401);
    expect((await fetch(`${hub.url}/v1/nothing`)).status).toBe(401);
  });

  it("pairing: code is single-use, expires, and the store keeps only hashes", async () => {
    const { code } = store.mintPairingCode();
    const ok = await pairVia({ label: "laptop", kind: "console" }, code);
    expect(ok.status).toBe(200);
    const { token, tokenId } = await ok.json();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect((await pairVia({ label: "laptop", kind: "console" }, code)).status).toBe(401); // used
    expect((await pairVia({ label: "x", kind: "console" }, "bogus")).status).toBe(401);
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(code);
    expect(store.list().map((t) => t.id)).toEqual([tokenId]);
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(token) })).status).toBe(200);
    // expiry
    let t = Date.now() - PAIRING_TTL_MS - 1000; // minted "in the past"
    const clocked = createTokenStore(dir, () => t);
    const c = clocked.mintPairingCode().code;
    t += PAIRING_TTL_MS + 1;
    expect((await pairVia({ label: "x", kind: "console" }, c)).status).toBe(401);
  });

  it("a worker pairing needs a hostId; it is stored on the token and the worker acts as that host", async () => {
    expect((await pairVia({ label: "w", kind: "worker" })).status).toBe(400);
    const { token, tokenId } = await mint("worker", { hostId: "sfo-01" });
    expect(store.list().find((x) => x.id === tokenId)).toMatchObject({ kind: "worker", hostId: "sfo-01" });
    const id = hub.authenticate({ headers: { authorization: `Bearer ${token}` } } as never);
    expect(id).toMatchObject({ tokenId, kind: "worker", hostId: "sfo-01" });
  });

  it("identity comes from the token: a forged X-Wolfpack-Actor is ignored", async () => {
    const worker = await mint("worker", { hostId: "sfo-01" });
    // a worker token asserting operator is still a wolf: registry writes are operator-only
    const forged = await fetch(`${hub.url}/v1/registry/hosts`, { method: "POST", headers: { "Content-Type": "application/json", ...bearer(worker.token, { [ACTOR_HEADER]: asOp }) }, body: "{}" });
    expect(forged.status).toBe(403);
    // and kb commits (operator only) too
    const kb = await fetch(`${hub.url}/v1/kb/commits`, { method: "POST", headers: { "Content-Type": "application/json", ...bearer(worker.token, { [ACTOR_HEADER]: asOp }) }, body: JSON.stringify({ changes: [] }) });
    expect(kb.status).toBe(403);
    // a console token needs no actor header at all, and a malformed one is ignored
    const con = await mint("console");
    expect((await createWork(bearer(con.token))).status).toBe(201);
    expect((await createWork(bearer(con.token, { [ACTOR_HEADER]: "{not json" }))).status).toBe(201);
    const asWolf = JSON.stringify({ id: "some-wolf", kind: "wolf" });
    const r = await createWork(bearer(con.token, { [ACTOR_HEADER]: asWolf }));
    expect(r.status).toBe(201);
    const ledger = readFileSync(join(dir, "ledger", "work-events.jsonl"), "utf8");
    expect(ledger).not.toContain("some-wolf");
  });

  it("revocation: the revoked token is 401 at once, without a restart", async () => {
    const a = await mint("console");
    const b = await mint("console");
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(a.token) })).status).toBe(200);
    expect(createTokenStore(dir).revoke(a.tokenId)).toBe(true); // as the CLI does, from another store instance
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(a.token) })).status).toBe(401);
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(b.token) })).status).toBe(200);
  });

  it("revocation closes an open SSE stream and fires onRevoke", async () => {
    const a = await mint("console");
    const seen: string[] = [];
    hub.onRevoke((id) => seen.push(id));
    const res = await fetch(`${hub.url}/v1/events`, { headers: bearer(a.token) });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    const closed = (async () => {
      try {
        while (!(await reader.read()).done);
      } catch {
        /* reset also counts as closed */
      }
      return true;
    })();
    store.revoke(a.tokenId);
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r("open"), 3000))])).toBe(true);
    expect(seen).toEqual([a.tokenId]);
  });

  it("the legacy API key still works (asserted actor) and has no token identity", async () => {
    expect((await createWork({ "X-API-Key": KEY })).status).toBe(400); // legacy mutations still need an actor header
    expect((await createWork({ "X-API-Key": KEY, [ACTOR_HEADER]: asOp })).status).toBe(201);
    expect(hub.authenticate({ headers: { "x-api-key": KEY } } as never)).toEqual({ owner: "owner", legacy: true });
    expect(hub.authenticate({ headers: {} } as never)).toBeNull();
  });

  it("starts with tokens only (no apiKey), and a bad bearer does not fall back to the key", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "hubd-auth2-"));
    const h2 = await createHubServer({ dataDir: d2, port: 0 });
    try {
      expect((await fetch(`${h2.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { "X-API-Key": KEY } })).status).toBe(401);
    } finally {
      await h2.close();
      rmSync(d2, { recursive: true, force: true });
    }
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { Authorization: "Bearer bad", "X-API-Key": KEY } })).status).toBe(401);
  });

  it("CLI: pair prints a code that pairs; tokens list never shows secrets; tokens revoke removes", async () => {
    const out: string[] = [];
    await main(["pair", "--data-dir", dir], {}, (m) => out.push(m));
    const code = /pairing code: (\S+)/.exec(out.join("\n"))![1]!;
    const { token, tokenId } = await (await pairVia({ label: "cli", kind: "browser" }, code)).json();
    out.length = 0;
    await main(["tokens", "list", "--data-dir", dir], {}, (m) => out.push(m));
    expect(out.join("\n")).toContain(tokenId);
    expect(out.join("\n")).not.toContain(token);
    await main(["tokens", "revoke", tokenId, "--data-dir", dir], {}, () => {});
    await expect(main(["tokens", "revoke", tokenId, "--data-dir", dir], {}, () => {})).rejects.toThrow(/no token/);
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(token) })).status).toBe(401);
  });
});
