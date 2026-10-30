/** Token auth: bearer required, identity from the token (forged actor ignored), pairing, revocation (incl. SSE close), CLI, legacy key. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";
import { main, parseArgs } from "./cli.js";
import { createTokenStore, PAIRING_TTL_MS, tryBreakStaleLock } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";

let dir = "";
let clock = Date.now();
let featureId = "";
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;
const KEY = "legacy-key-0123456789";
const CON = { kind: "console" } as const;
const asOp = JSON.stringify({ id: "forged-operator", kind: "operator" });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-auth-"));
  featureId = seedFixture(dir).feature.id;
  clock = Date.now();
  hub = await createHubServer({ dataDir: dir, apiKey: KEY, port: 0, authPollMs: 50, now: () => clock });
  store = createTokenStore(dir, () => clock);
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const pairVia = async (body: Record<string, unknown>, code = store.mintPairingCode({ kind: (body.kind as "console") ?? "console", hostId: body.hostId as string | undefined }).code) =>
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
    const { code } = store.mintPairingCode(CON);
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
  });

  it("a pairing code is valid just under 10 minutes and expired just over (hub and store share the clock)", async () => {
    const a = store.mintPairingCode(CON).code;
    clock += PAIRING_TTL_MS - 1000;
    expect((await pairVia({ label: "x", kind: "console" }, a)).status).toBe(200);
    const b = store.mintPairingCode(CON).code;
    clock += PAIRING_TTL_MS + 1000;
    expect((await pairVia({ label: "x", kind: "console" }, b)).status).toBe(401);
  });

  it("redeeming the same code in parallel gives exactly one 200", async () => {
    const { code } = store.mintPairingCode(CON);
    const rs = await Promise.all(Array.from({ length: 8 }, () => pairVia({ label: "p", kind: "console" }, code)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 401)).toHaveLength(7);
    expect(store.list()).toHaveLength(1);
  });

  it("concurrent store writers from two instances lose nothing (pair, redeem, revoke)", async () => {
    const other = createTokenStore(dir, () => clock);
    const codes = Array.from({ length: 6 }, (_, i) => (i % 2 ? store : other).mintPairingCode(CON).code);
    const ids = codes.map((c, i) => (i % 2 ? other : store).redeem(c, "d", "console").tokenId);
    expect(store.list().map((t) => t.id).sort()).toEqual([...ids].sort());
    other.revoke(ids[0]!);
    store.redeem(store.mintPairingCode(CON).code, "d", "console");
    expect(store.list().map((t) => t.id)).not.toContain(ids[0]);
    expect(store.list()).toHaveLength(6);
  });

  it("a revoke from a second store between verify and touch never brings the token back; lastUsedAt stays out of tokens.json", async () => {
    const { token, tokenId } = await mint("console");
    const rec = store.verify(token)!;
    createTokenStore(dir).revoke(tokenId); // the CLI, another process
    store.touch(rec.id);
    store.flush();
    expect(store.verify(token)).toBeUndefined();
    expect(store.ids()).toEqual([]);
    expect(readFileSync(store.file, "utf8")).not.toContain("lastUsedAt");
    // and a live token's use shows in `tokens list` via last-used.json
    const b = await mint("console");
    store.touch(b.tokenId);
    store.flush();
    expect(readFileSync(store.lastUsedFile, "utf8")).toContain(b.tokenId);
    expect(createTokenStore(dir).list().find((t) => t.id === b.tokenId)?.lastUsedAt).not.toBeNull();
  });

  it("a corrupt tokens.json is 401 (not 500) for bearers, and is not overwritten by writers", async () => {
    const { token } = await mint("console");
    writeFileSync(store.file, "{not json");
    const r = await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: bearer(token) });
    expect(r.status).toBe(401);
    expect(() => store.mintPairingCode(CON)).toThrow();
    expect(readFileSync(store.file, "utf8")).toBe("{not json");
  });

  it("a failed redeem does not rewrite tokens.json; repeated failures are limited with 429", async () => {
    await mint("console");
    const before = readFileSync(store.file, "utf8");
    const mtime = statSync(store.file).mtimeMs;
    for (let i = 0; i < 10; i++) expect((await pairVia({ label: "x", kind: "console" }, `bad-${i}`)).status).toBe(401);
    expect(readFileSync(store.file, "utf8")).toBe(before);
    expect(statSync(store.file).mtimeMs).toBe(mtime);
    const limited = await pairVia({ label: "x", kind: "console" }, "bad-again");
    expect(limited.status).toBe(429);
    expect((await limited.json()).retryable).toBe(true);
    // a valid code is refused too while limited, and works after the window
    clock += 61_000;
    expect((await pairVia({ label: "x", kind: "console" })).status).toBe(200);
  });

  it("an unauthenticated wrong method is 401, not 405", async () => {
    expect((await fetch(`${hub.url}/v1/work/x/record`, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${hub.url}/v1/events`, { method: "POST" })).status).toBe(401);
  });

  it("a token-authenticated work write is attributed to its token and host in auth/attribution.jsonl", async () => {
    const con = await mint("console");
    const r = await createWork(bearer(con.token));
    expect(r.status).toBe(201);
    const lines = readFileSync(join(dir, "auth", "attribution.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ tokenId: con.tokenId, actor: { id: "owner", kind: "operator" } });
    expect(lines.at(-1).events[0].type).toBe("work.created");
  });

  it("a worker pairing needs a hostId; it is stored on the token and the worker acts as that host", async () => {
    expect(() => store.mintPairingCode({ kind: "worker" })).toThrow(/hostId/); // a worker code is minted for a host
    expect(() => store.mintPairingCode({ kind: "console", hostId: "x" })).toThrow(/worker/);
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
    // the asserted actor is honoured on the legacy path: a wolf actor is refused an operator-only write, the operator is not
    const reg = (actor: string) => fetch(`${hub.url}/v1/registry/hosts`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY, [ACTOR_HEADER]: actor }, body: "{}" });
    expect((await reg(JSON.stringify({ id: "w", kind: "wolf" }))).status).toBe(403);
    expect((await reg(asOp)).status).not.toBe(403);
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

  it("the code fixes kind and hostId: a mismatch is 401 (and does not consume the code), a match or omission works", async () => {
    const { code } = store.mintPairingCode({ kind: "worker", hostId: "sfo-01" });
    expect((await pairVia({ label: "w", kind: "console" }, code)).status).toBe(401);
    expect((await pairVia({ label: "w", kind: "worker", hostId: "1uk4" }, code)).status).toBe(401); // cannot choose another host
    expect((await pairVia({ label: "w", hostId: "1uk4" }, code)).status).toBe(401);
    const ok = await pairVia({ label: "w" }, code); // omitted: taken from the code
    expect(ok.status).toBe(200);
    const { tokenId } = (await ok.json()) as { tokenId: string };
    expect(store.list().find((t) => t.id === tokenId)).toMatchObject({ kind: "worker", hostId: "sfo-01" });
  });

  it("CLI pair: --kind is required, worker needs --host-id, others refuse it", () => {
    expect(() => parseArgs(["pair", "--data-dir", "/d"])).toThrow(/--kind/);
    expect(() => parseArgs(["pair", "--kind", "worker", "--data-dir", "/d"])).toThrow(/--host-id/);
    expect(() => parseArgs(["pair", "--kind", "console", "--host-id", "x", "--data-dir", "/d"])).toThrow(/only for --kind worker/);
    expect(parseArgs(["pair", "--kind", "worker", "--host-id", "sfo-01", "--data-dir", "/d"])).toMatchObject({ kind: "worker", hostId: "sfo-01" });
  });

  it("a worker token's tokenId and hostId land in attribution.jsonl", async () => {
    const w = await mint("worker", { hostId: "sfo-01" });
    expect((await createWork(bearer(w.token))).status).toBe(201);
    const last = readFileSync(join(dir, "auth", "attribution.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    expect(last).toMatchObject({ tokenId: w.tokenId, hostId: "sfo-01", actor: { id: "sfo-01", kind: "wolf" } });
  });

  describe("token store lock", () => {
    const lockPath = () => {
      mkdirSync(join(dir, "auth"), { recursive: true });
      return `${store.file}.lock`;
    };
    const old = (f: string) => utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    it("a fresh lock held by someone else means `busy` at once (injectable wait), through the hub and the store", async () => {
      writeFileSync(lockPath(), "someone-else");
      const t0 = Date.now();
      const impatient = createTokenStore(dir, () => clock, { waitMs: 0 });
      expect(() => impatient.mintPairingCode(CON)).toThrow(/locked/);
      const code = "x"; // the hub itself fails fast too (default authLockWaitMs 0): 409 busy, retryable, no stall
      const r = await pairVia({ label: "x", kind: "console" }, code);
      expect([401, 409]).toContain(r.status);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(readFileSync(lockPath(), "utf8")).toBe("someone-else"); // not stolen, not removed
    });

    it("a stale lock (old mtime) is broken and the write succeeds", () => {
      writeFileSync(lockPath(), "dead-holder");
      old(lockPath());
      const c = createTokenStore(dir, () => clock, { waitMs: 0 }).mintPairingCode(CON);
      expect(c.code).toBeTruthy();
      expect(existsSync(lockPath())).toBe(false); // released
    });

    it("hub redeem is busy (409, retryable) while another process holds a fresh lock", async () => {
      const { code } = store.mintPairingCode(CON);
      writeFileSync(lockPath(), "someone-else");
      const r = await pairVia({ label: "x", kind: "console" }, code);
      expect(r.status).toBe(409);
      expect((await r.json()).retryable).toBe(true);
      rmSync(lockPath());
      expect((await pairVia({ label: "x", kind: "console" }, code)).status).toBe(200); // the code survived
    });

    it("two waiters racing on a stale lock: exactly one breaks it", () => {
      writeFileSync(lockPath(), "dead-holder");
      old(lockPath());
      const results = [tryBreakStaleLock(lockPath(), 10_000), tryBreakStaleLock(lockPath(), 10_000)];
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(existsSync(lockPath())).toBe(false);
    });

    it("breaking a lock that turns out fresh puts it back", () => {
      writeFileSync(lockPath(), "live-holder"); // fresh: not stale
      expect(tryBreakStaleLock(lockPath(), 10_000)).toBe(false);
      expect(readFileSync(lockPath(), "utf8")).toBe("live-holder");
    });

    it("release only removes a lock that still holds our nonce", () => {
      const s2 = createTokenStore(dir, () => clock, { waitMs: 0 });
      // another process replaced our lock mid-operation (we were judged stale): its lock must survive our release
      const orig = s2.mintPairingCode;
      void orig;
      let swapped = false;
      const c = s2.withLockForTest(() => {
        rmSync(lockPath());
        writeFileSync(lockPath(), "other-nonce");
        swapped = true;
      });
      void c;
      expect(swapped).toBe(true);
      expect(readFileSync(lockPath(), "utf8")).toBe("other-nonce");
    });
  });

  it("flush does not wipe last-used.json while tokens.json is corrupt", async () => {
    const { tokenId } = await mint("console");
    store.touch(tokenId);
    store.flush();
    const before = readFileSync(store.lastUsedFile, "utf8");
    expect(before).toContain(tokenId);
    writeFileSync(store.file, "{corrupt");
    store.touch(tokenId);
    store.flush();
    expect(readFileSync(store.lastUsedFile, "utf8")).toBe(before);
  });

  it("CLI: pair prints a code that pairs; tokens list never shows secrets; tokens revoke removes", async () => {
    const out: string[] = [];
    await main(["pair", "--kind", "browser", "--data-dir", dir], {}, (m) => out.push(m));
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
