import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkerdServer } from "./proxy.js";
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
