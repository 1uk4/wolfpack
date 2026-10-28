import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkList } from "./memory-read.js";

let server: Server | undefined;
let lastUrl = "";
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const serve = async (status: number, body: unknown): Promise<string> => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? "";
    if (req.headers["x-api-key"] !== "tok") return void res.writeHead(401).end();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const items = [
  { id: "f1", title: "Feat", kind: "feature", stage: "in_build", domain: "d", partOf: "i1", dependsOn: ["f0"], assignee: "me", created: "2026-10-01", extra: 1 },
  { id: "i1", title: "Init", kind: "initiative", stage: "plan", domain: "d", standing: true, graduated: null },
  { id: "g1", title: "Done", kind: "feature", stage: "shipped", domain: "d", graduated: "2026-10-02" },
  { id: "a1", title: "Old", kind: "task", stage: "archived", domain: "d" },
  { title: "no id" },
];

describe("readWorkList", () => {
  it("filters by domain, maps the view's fields and hides graduated and archived items by default", async () => {
    const url = await serve(200, { items });
    const r = await readWorkList("my domain", false, { endpoint: url, token: "tok" });
    expect(lastUrl).toBe("/work?domain=my%20domain");
    expect(r).toEqual({
      kind: "ok",
      items: [
        { id: "f1", title: "Feat", kind: "feature", stage: "in_build", domain: "d", partOf: "i1", dependsOn: ["f0"], assignee: "me", created: "2026-10-01" },
        { id: "i1", title: "Init", kind: "initiative", stage: "plan", domain: "d", partOf: null, dependsOn: [], standing: true },
      ],
    });
  });
  it("keeps graduated and archived items when asked, carrying the graduated date", async () => {
    const url = await serve(200, { items });
    const r = await readWorkList("d", true, { endpoint: url, token: "tok" });
    expect(r.kind === "ok" && r.items.map((i) => i.id)).toEqual(["f1", "i1", "g1", "a1"]);
    expect(r.kind === "ok" && r.items[2]!.graduated).toBe("2026-10-02");
  });
  it("reports unconfigured, refused and unreachable", async () => {
    expect(await readWorkList("d", false, {})).toEqual({ kind: "unconfigured" });
    expect((await readWorkList("d", false, { endpoint: "http://127.0.0.1:1", token: "tok" })).kind).toBe("error");
    const url = await serve(200, { items: [] });
    expect(await readWorkList("d", false, { endpoint: url, token: "wrong" })).toEqual({ kind: "error", message: "HTTP 401" });
  });
});
