import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWorkSources } from "./memory-read.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const serve = async (status: number, body: unknown): Promise<string> => {
  server = createServer((req, res) => {
    if (req.headers["x-api-key"] !== "tok") return void res.writeHead(401).end();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe("fetchWorkSources", () => {
  it("maps the Work API items for the graph builder, dropping ones without id or domain", async () => {
    const url = await serve(200, { items: [{ id: "a", domain: "d", title: "T", kind: "task", stage: "plan", partOf: "p", dependsOn: ["x"], assignee: "me", updated: "u", extra: 1 }, { id: "b" }, { domain: "d" }] });
    expect(await fetchWorkSources(url, "tok")).toEqual([{ id: "a", domain: "d", title: "T", kind: "task", stage: "plan", partOf: "p", dependsOn: ["x"], assignee: "me", updated: "u" }]);
  });
  it("is undefined (so the graph falls back to the work files) when unconfigured, refused or unreachable", async () => {
    expect(await fetchWorkSources(undefined, "tok")).toBeUndefined();
    expect(await fetchWorkSources("http://127.0.0.1:1", undefined)).toBeUndefined();
    expect(await fetchWorkSources("http://127.0.0.1:1", "tok")).toBeUndefined();
    const url = await serve(200, { items: [] });
    expect(await fetchWorkSources(url, "wrong")).toBeUndefined();
  });
});
