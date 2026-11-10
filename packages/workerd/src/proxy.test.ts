import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DIRECT_TOKEN_HEADER, ensureDirectToken } from "./direct-token.js";
import { healthShapeProblems } from "@wolfpack/protocol/stub";
import { WorkerdServer, isLoopbackPeer } from "./proxy.js";
import { staticRegistry } from "./registry.js";
import { Supervisor } from "./supervisor.js";
import { FAKE_COMMAND, makeWolves } from "./testing/helpers.js";

let root = "";
let sup: Supervisor;
let server: WorkerdServer;
let base = "";

beforeAll(async () => {
  const m = makeWolves("alpha", "beta", "gamma");
  root = m.root;
  sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, log: () => {}, backoff: { baseMs: 60_000, capMs: 60_000, healthyResetMs: 60_000 } });
  sup.start();
  await sup.whenSettled();
  server = new WorkerdServer({ registry: sup, health: () => ({ ok: true, wolves: sup.status() }) });
  base = await server.listen();
});
afterAll(async () => {
  await server.close();
  await sup.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("workerd proxy", () => {
  it("aggregates /v1/wolves", async () => {
    const body = await (await fetch(`${base}/v1/wolves`)).json();
    expect(body.wolves.map((w: { name: string; status: string }) => [w.name, w.status])).toEqual([["alpha", "online"], ["beta", "online"], ["gamma", "online"]]);
  });

  it("routes wolves/:name/* by path and threads/:id by id prefix", async () => {
    for (const n of ["alpha", "beta"]) {
      const t = await (await fetch(`${base}/v1/wolves/${n}/threads`)).json();
      expect(t.threads[0].wolf).toBe(n);
      const d = await (await fetch(`${base}/v1/threads/${encodeURIComponent(`${n}/home`)}`)).json();
      expect(d.served_by).toBe(n);
    }
  });

  it("passes the librarian flag through the aggregate (omitted when the wolf does not report it)", async () => {
    const body = await (await fetch(`${base}/v1/wolves`)).json();
    expect(body.wolves.map((w: { name: string; librarian?: boolean }) => [w.name, w.librarian])).toEqual([["alpha", false], ["beta", true], ["gamma", false]]);
  });

  it("passes kbReadable through the aggregate (omitted when the wolf does not report it)", async () => {
    const body = await (await fetch(`${base}/v1/wolves`)).json();
    expect(body.wolves.map((w: { name: string; kbReadable?: boolean }) => [w.name, w.kbReadable])).toEqual([["alpha", true], ["beta", undefined], ["gamma", undefined]]);
  });

  it("forwards the memory status, topic and work record routes unchanged (path params and query)", async () => {
    for (const n of ["alpha", "beta"]) {
      expect(await (await fetch(`${base}/v1/wolves/${n}/memory?thread=${encodeURIComponent(`${n}/home`)}`)).json()).toEqual({ served_by: n, query: `?thread=${encodeURIComponent(`${n}/home`)}` });
      expect(await (await fetch(`${base}/v1/wolves/${n}/memory/topics/caching?scope=den`)).json()).toEqual({ served_by: n, topic: "caching", query: "?scope=den" });
      expect(await (await fetch(`${base}/v1/wolves/${n}/work/work-wolfpack-abcdefg/record`)).json()).toEqual({ served_by: n, work: "work-wolfpack-abcdefg" });
    }
    for (const p of ["/v1/wolves/nope/memory", "/v1/wolves/nope/memory/topics/x", "/v1/wolves/nope/work/work-wolfpack-abcdefg/record"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("404 not_found envelope for an unknown wolf", async () => {
    for (const p of ["/v1/wolves/nope/threads", `/v1/threads/${encodeURIComponent("nope/home")}`, "/v1/threads/nohome"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: "not_found", retryable: false });
    }
  });

  it("passes request headers and method through", async () => {
    const r = await fetch(`${base}/v1/threads/${encodeURIComponent("alpha/home")}`, { headers: { "X-Protocol-Version": "1", "Last-Event-ID": "42" } });
    expect(await r.json()).toMatchObject({ version: "1", lastEventId: "42" });
  });

  it("streams SSE without buffering, in order, echoing Last-Event-ID", async () => {
    const r = await fetch(`${base}/v1/threads/${encodeURIComponent("beta/home")}/stream`, { headers: { "Last-Event-ID": "7" } });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const start = Date.now();
    const arrivals: { at: number; text: string }[] = [];
    const dec = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) arrivals.push({ at: Date.now() - start, text: dec.decode(chunk) });
    const all = arrivals.map((a) => a.text).join("");
    expect(all.startsWith('id: 1\ndata: {"lastEventId":"7"}')).toBe(true);
    expect(all.indexOf("frame-2")).toBeLessThan(all.indexOf("frame-3"));
    expect(all.endsWith("data: [DONE]\n\n")).toBe(true);
    // fake emits one frame per 150ms: unbuffered means several chunks spread over time
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    expect(arrivals[0].at).toBeLessThan(120);
    expect(arrivals.at(-1)!.at).toBeGreaterThan(350);
  });

  it("/healthz lists children with restart counts", async () => {
    const h = await (await fetch(`${base}/healthz`)).json();
    expect(h.wolves.map((w: { name: string; restarts: number }) => [w.name, w.restarts])).toEqual([["alpha", 0], ["beta", 0], ["gamma", 0]]);
    expect(healthShapeProblems(h, "workerd", `${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}-dev`)).toEqual([]); // pack-health fields ride along, old fields kept
    for (const w of h.wolves) expect(Object.keys(w).filter((k) => k === "url" || k === "logFile")).toEqual([]); // unauthenticated: no socket or log paths
  });

  it("offline wolf: listed offline, requests 502 engine_error retryable; recovers on restart", async () => {
    const m = makeWolves("solo");
    const s = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, log: () => {}, backoff: { baseMs: 300, capMs: 300, healthyResetMs: 60_000 } });
    const srv = new WorkerdServer({ registry: s });
    const b = await srv.listen();
    try {
      s.start();
      await s.whenSettled();
      await fetch(`${s.upstream("solo")}/crash`).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect((await (await fetch(`${b}/v1/wolves`)).json()).wolves[0].status).toBe("offline");
      const r = await fetch(`${b}/v1/wolves/solo/threads`);
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: "engine_error", retryable: true });
      await s.whenSettled();
      await new Promise((r) => setTimeout(r, 400));
      expect((await fetch(`${b}/v1/wolves/solo/threads`)).status).toBe(200);
    } finally {
      await srv.close();
      await s.stop();
      rmSync(m.root, { recursive: true, force: true });
    }
  });
});

describe("direct console path (/direct/v1)", () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  /** A wolf that echoes the path and headers it received; workerd in front of it with a fresh token dir. */
  async function rig(o: { isLoopback?: () => boolean; tokenFile?: string } = {}) {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const wolf = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => wolf.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(join(tmpdir(), "workerd-direct-"));
    if (o.tokenFile !== undefined) writeFileSync(join(dir, "direct-token"), o.tokenFile, { mode: 0o600 });
    const token = ensureDirectToken(dir);
    const srv = new WorkerdServer({ registry: staticRegistry({ alpha: `http://127.0.0.1:${(wolf.address() as AddressInfo).port}` }), directToken: () => ensureDirectToken(dir), ...(o.isLoopback ? { isLoopback: o.isLoopback } : {}) });
    const url = await srv.listen();
    closers.push(() => srv.close(), () => new Promise<void>((r) => wolf.close(() => r())), () => rmSync(dir, { recursive: true, force: true }));
    return { url, token, seen, dir };
  }

  it("serves /v1 under /direct with the local token, forwarding the normalised /v1 path", async () => {
    const r = await rig();
    const ok = await fetch(`${r.url}/direct/v1/wolves/alpha/threads?x=1`, { headers: { [DIRECT_TOKEN_HEADER]: r.token } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: "/v1/wolves/alpha/threads?x=1" });
    const dotted = await fetch(`${r.url}/direct/v1/wolves/alpha/./threads`, { headers: { [DIRECT_TOKEN_HEADER]: r.token } });
    expect(await dotted.json()).toEqual({ path: "/v1/wolves/alpha/threads" });
  });

  it("an empty or invalid token file heals into a valid 0600 token the proxy accepts", async () => {
    for (const content of ["", "not a token!\n"]) {
      const r = await rig({ tokenFile: content });
      expect([JSON.stringify(content), r.token]).toEqual([JSON.stringify(content), expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)]);
      expect(readFileSync(join(r.dir, "direct-token"), "utf8")).toBe(`${r.token}\n`);
      expect(statSync(join(r.dir, "direct-token")).mode & 0o777).toBe(0o600);
      const res = await fetch(`${r.url}/direct/v1/wolves/alpha/threads`, { headers: { [DIRECT_TOKEN_HEADER]: r.token } });
      expect(res.status).toBe(200);
    }
  });

  it("never forwards the token header to the wolf", async () => {
    const r = await rig();
    await fetch(`${r.url}/direct/v1/wolves/alpha/threads`, { headers: { [DIRECT_TOKEN_HEADER]: r.token } });
    expect(r.seen.map((s) => [s.url, s.headers[DIRECT_TOKEN_HEADER]])).toEqual([["/v1/wolves/alpha/threads", undefined]]);
  });

  it("a missing or wrong token is 401 and nothing reaches the wolf", async () => {
    const r = await rig();
    const wrong = await fetch(`${r.url}/direct/v1/wolves/alpha/threads`, { headers: { [DIRECT_TOKEN_HEADER]: "nope" } });
    expect([wrong.status, (await wrong.json()).code]).toEqual([401, "unauthorized"]);
    expect((await fetch(`${r.url}/direct/v1/wolves/alpha/threads`)).status).toBe(401);
    expect(r.seen).toEqual([]);
  });

  it("a caller off loopback is 403, even with the right token", async () => {
    const r = await rig({ isLoopback: () => false });
    const res = await fetch(`${r.url}/direct/v1/wolves/alpha/threads`, { headers: { [DIRECT_TOKEN_HEADER]: r.token } });
    expect([res.status, (await res.json()).code]).toEqual([403, "forbidden"]);
    expect(r.seen).toEqual([]);
  });

  it("a request that came through a proxy (forwarding headers) is 403, even on loopback with the right token", async () => {
    const r = await rig();
    for (const h of [{ "x-forwarded-for": "203.0.113.9" }, { "x-forwarded-host": "mac.tail.ts.net" }, { forwarded: "for=203.0.113.9" }, { via: "1.1 tailscale" }]) {
      const res = await fetch(`${r.url}/direct/v1/wolves/alpha/threads`, { headers: { [DIRECT_TOKEN_HEADER]: r.token, ...h } });
      expect([Object.keys(h)[0], res.status]).toEqual([Object.keys(h)[0], 403]);
    }
    expect(r.seen).toEqual([]);
  });

  it("the default loopback check accepts IPv4, IPv6 and IPv4-mapped loopback only", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.5", "::ffff:192.168.1.5", "fe80::1", undefined].map((a) => isLoopbackPeer(a))).toEqual([true, true, true, false, false, false, false]);
  });
});

describe("direct token file", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "workerd-token-"));
    dirs.push(d);
    return d;
  };

  it("is created once with mode 0600 and the same token is returned afterwards", () => {
    const dir = fresh();
    const token = ensureDirectToken(dir);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(dir, "direct-token")).mode & 0o777).toBe(0o600);
    expect(ensureDirectToken(dir)).toBe(token);
  });

  it("a token another process already wrote is used, never overwritten", () => {
    const dir = fresh();
    const theirs = "a".repeat(43);
    writeFileSync(join(dir, "direct-token"), `${theirs}\n`, { mode: 0o600 });
    expect(ensureDirectToken(dir)).toBe(theirs);
    expect(readFileSync(join(dir, "direct-token"), "utf8")).toBe(`${theirs}\n`);
  });

  it("refuses a symlinked token file", () => {
    const dir = fresh();
    writeFileSync(join(dir, "elsewhere"), `${"b".repeat(43)}\n`, { mode: 0o600 });
    symlinkSync(join(dir, "elsewhere"), join(dir, "direct-token"));
    expect(() => ensureDirectToken(dir)).toThrow(/symlink/);
  });

  it("tightens a token file readable by others to 0600 and logs it once", () => {
    const dir = fresh();
    const file = join(dir, "direct-token");
    writeFileSync(file, `${"c".repeat(43)}\n`);
    chmodSync(file, 0o644);
    const logs: string[] = [];
    expect(ensureDirectToken(dir, (m) => logs.push(m))).toBe("c".repeat(43));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    ensureDirectToken(dir, (m) => logs.push(m));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(logs.length).toBe(1);
  });
});
