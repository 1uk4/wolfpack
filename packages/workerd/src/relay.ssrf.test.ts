import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkFrame } from "@wolfpack/protocol";
import { WorkerRelay } from "./relay.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));
const listen = async (onReq: (url: string) => void) => {
  const hits: string[] = [];
  const s = createServer((req, res) => (hits.push(req.url ?? ""), onReq(req.url ?? ""), res.end("ok")));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => s.close());
  return { hits, port: (s.address() as AddressInfo).port, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};

describe("WorkerRelay refuses request targets that leave the worker", () => {
  it("absolute-form, //host, backslash and bad methods get rerr and nothing connects", async () => {
    const worker = await listen(() => {});
    const canary = await listen(() => {});
    const sent: LinkFrame[] = [];
    const relay = new WorkerRelay({ baseUrl: () => worker.base, send: (f) => (sent.push(f), true) });
    const bad = [
      `http://127.0.0.1:${canary.port}/v1/wolves/a/threads`,
      `//127.0.0.1:${canary.port}/v1/wolves/a/threads`,
      `/\\127.0.0.1:${canary.port}/x`,
      `http://evil:8080/v1/wolves/a/threads`,
      "v1/wolves/a/threads",
      "/v1/a b",
      " /v1/x",
      "\t/v1/x",
      "HtTp://[::1]:1/x",
      "http://[::1]/x",
    ];
    bad.forEach((path, i) => relay.handle({ t: "req", id: `h-${i}`, method: "GET", path, headers: {} }));
    relay.handle({ t: "req", id: "h-m", method: "CONNECT", path: "/v1/x", headers: {} });
    expect(sent.map((f) => f.t)).toEqual(Array(bad.length + 1).fill("rerr"));
    await new Promise((r) => setTimeout(r, 100));
    expect(canary.hits).toEqual([]);
    expect(worker.hits).toEqual([]);
    expect(relay.inflight()).toBe(0);
  });

  it("the direct console path is never reachable through the hub, however the path is spelled", async () => {
    const worker = await listen(() => {});
    const sent: LinkFrame[] = [];
    const relay = new WorkerRelay({ baseUrl: () => worker.base, send: (f) => (sent.push(f), true) });
    const paths = ["/direct/v1/wolves", "/%64irect/v1/wolves", "/v1/../direct/v1/wolves", "/v1/%2e%2e/direct/v1/wolves", "/DIRECT/v1/wolves"];
    paths.forEach((path, i) => relay.handle({ t: "req", id: `d-${i}`, method: "GET", path, headers: {} }));
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.map((f) => [f.t, (f as { id: string }).id])).toEqual(paths.map((_, i) => ["rerr", `d-${i}`]));
    expect(worker.hits).toEqual([]);
  });

  it("an encoded // is just a path: forwarded unchanged to the worker's own origin", async () => {
    const worker = await listen(() => {});
    const sent: LinkFrame[] = [];
    const relay = new WorkerRelay({ baseUrl: () => worker.base, send: (f) => (sent.push(f), true) });
    relay.handle({ t: "req", id: "h-1", method: "GET", path: "/%2F%2Fevil/x", headers: {} });
    await new Promise((r) => setTimeout(r, 150));
    expect(worker.hits).toEqual(["/%2F%2Fevil/x"]);
    expect(sent.at(-1)!.t).toBe("end");
  });

  it("a good path reaches only the worker's own origin; oversized bodies and floods are refused", async () => {
    const worker = await listen(() => {});
    const sent: LinkFrame[] = [];
    const relay = new WorkerRelay({ baseUrl: () => worker.base, send: (f) => (sent.push(f), true) });
    relay.handle({ t: "req", id: "h-1", method: "GET", path: "/v1/wolves/a/threads?x=1", headers: { host: "evil" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(worker.hits).toEqual(["/v1/wolves/a/threads?x=1"]);
    expect(sent.at(-1)!.t).toBe("end");
    relay.handle({ t: "req", id: "h-2", method: "POST", path: "/v1/x", headers: {}, body: "A".repeat(4 * 1024 * 1024) });
    expect(sent.at(-1)).toMatchObject({ t: "rerr", id: "h-2" });
  });
});
