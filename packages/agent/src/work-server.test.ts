import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalWorkServer, type LocalWorkServer } from "./work-server.js";

const TOKEN = "test-token";

describe("local work server", () => {
  let dir: string;
  let srv: LocalWorkServer;

  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    fetch(`${srv.url}/work${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-API-Key": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-server-test-"));
    srv = await startLocalWorkServer({ ledgerDir: dir, token: TOKEN });
  });
  afterAll(() => srv.close());

  it("rejects requests without the token", async () => {
    expect((await call("GET", "", undefined, null)).status).toBe(401);
    expect((await call("GET", "", undefined, "wrong")).status).toBe(401);
  });

  it("creates, stages and notes an item into the given ledger dir only", async () => {
    const created = await call("POST", "", {
      kind: "task",
      domain: "snapjack",
      title: "sandbox task",
      assignee: "owner",
      successCriteria: "works",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const staged = await call("PATCH", `/${id}`, { stage: "approved" });
    expect(staged.status).toBe(200);
    const noted = await call("PATCH", `/${id}`, { note: "hello" });
    expect(noted.status).toBe(200);

    const file = join(dir, "ledger", "work-events.jsonl");
    const events = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThanOrEqual(3);
    const mine = events.filter((e) => e.id === id);
    expect(mine.map((e) => e.type)).toEqual(expect.arrayContaining(["work.created", "work.staged", "work.noted"]));
    // Nothing leaked to the agent's default ledger location.
    expect(existsSync(join(process.cwd(), "ledger", "work-events.jsonl"))).toBe(false);

    const got = (await (await call("GET", `/${id}`)).json()) as { item: { stage: string } };
    expect(got.item.stage).toBe("approved");
  });

  it("rejects an invalid event without writing it", async () => {
    const file = join(dir, "ledger", "work-events.jsonl");
    const before = readFileSync(file, "utf-8");
    const res = await call("POST", "", { kind: "bogus", domain: "snapjack", title: "x", assignee: "owner" });
    expect(res.status).toBe(400);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});
