import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeHealth } from "./health.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/healthz`;
}
const json = (body: unknown, status = 200) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("probeHealth", () => {
  it("grades a prompt, low-lag answer ok and carries lag and body", async () => {
    const url = await serve(json({ ok: true, service: "hubd", lag: { p99Ms: 3, maxMs: 9 } }));
    const r = await probeHealth(url);
    expect(r).toMatchObject({ status: "ok", lagMs: 3, body: { service: "hubd" } });
    expect(r.responseMs).toBeLessThan(1000);
    expect(new Date(r.checkedAt).toISOString()).toBe(r.checkedAt);
    expect(r.error).toBeUndefined();
  });

  it("grades a slow answer degraded", async () => {
    const url = await serve((_req, res) => setTimeout(() => json({ ok: true })(_req, res), 150));
    const r = await probeHealth(url, { degradedResponseMs: 50, timeoutMs: 2000 });
    expect(r.status).toBe("degraded");
    expect(r.responseMs).toBeGreaterThanOrEqual(50);
  });

  it("grades an answer reporting a high event-loop lag degraded", async () => {
    const url = await serve(json({ ok: true, lag: { p99Ms: 450, maxMs: 900 } }));
    expect((await probeHealth(url)).status).toBe("degraded");
  });

  it("grades a service that never answers (frozen event loop) down at the timeout", async () => {
    const url = await serve(() => {}); // accepts the request, never responds
    const r = await probeHealth(url, { timeoutMs: 100 });
    expect(r.status).toBe("down");
    expect(r.responseMs).toBeGreaterThanOrEqual(100); // the real elapsed time, not capped at the timeout
    expect(Date.parse(r.checkedAt)).toBeGreaterThanOrEqual(Date.now() - 5_000);
    expect(r.error).toContain("no answer within 100ms");
  });

  it("grades a refused connection down with the reason", async () => {
    const url = await serve(json({ ok: true }));
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); // port now closed
    const r = await probeHealth(url, { timeoutMs: 2000 });
    expect(r.status).toBe("down");
    expect(r.error).toBe("ECONNREFUSED");
  });

  it("grades a body that is valid JSON but not an object down", async () => {
    const url = await serve(json([1, 2]));
    expect(await probeHealth(url)).toMatchObject({ status: "down", error: "unparseable health body" });
  });

  it("grades an answer from a different service down", async () => {
    const url = await serve(json({ ok: true, service: "workerd" }));
    expect(await probeHealth(url, { expectService: "hubd" })).toMatchObject({ status: "down", error: "wrong service" });
  });

  it("grades a service reporting ok: false degraded", async () => {
    const url = await serve(json({ ok: false, service: "hubd" }));
    expect(await probeHealth(url, { expectService: "hubd" })).toMatchObject({ status: "degraded" });
  });

  it("grades an HTTP error down", async () => {
    const url = await serve(json({ code: "engine_error" }, 500));
    expect(await probeHealth(url)).toMatchObject({ status: "down", error: "HTTP 500" });
  });
});
