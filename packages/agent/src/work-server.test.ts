import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalWorkServer, type LocalWorkServer } from "./work-server.js";

const TOKEN = "test-token";

describe("local work server", () => {
  let dir: string;
  let srv: LocalWorkServer;
  let sentinel: string;
  const saved = { KB_BASE: process.env.KB_BASE, WORK_LEDGER_DIR: process.env.WORK_LEDGER_DIR };

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
    sentinel = mkdtempSync(join(tmpdir(), "work-server-sentinel-"));
    process.env.KB_BASE = join(sentinel, "base");
    process.env.WORK_LEDGER_DIR = join(sentinel, "work");
    srv = await startLocalWorkServer({ ledgerDir: dir, token: TOKEN });
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await srv.close();
  });

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
    // Materialized file lives inside ledgerDir; env-default roots stay untouched.
    expect(existsSync(join(dir, "base", "domains", "snapjack", "work", `${id}.md`))).toBe(true);
    expect(readdirSync(sentinel)).toEqual([]);

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

describe("local work server on a sandbox root takes the single-writer lock itself", () => {
  it("a second server over the same sandbox ledger fails loudly; close releases; a plain ledger dir is not locked", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "ws-sbx-"));
    writeFileSync(join(root, "snapshot.json"), "{}");
    mkdirSync(join(root, "ledger"), { recursive: true });
    const a = await startLocalWorkServer({ ledgerDir: root, token: "t" });
    const run = JSON.parse(readFileSync(join(root, "run", "work-server.json"), "utf8"));
    expect(run).toMatchObject({ url: a.url, token: "t", pid: process.pid });
    // another live process would be refused: simulate by a lock owned by the parent
    await a.close();
    expect(existsSync(join(root, "run", "work-server.lock"))).toBe(false);
    writeFileSync(join(root, "run", "work-server.lock"), JSON.stringify({ pid: process.ppid }));
    await expect(startLocalWorkServer({ ledgerDir: root, token: "t" })).rejects.toThrow(/already has a writer/);
    // same-process second start is also refused while the first runs
    const plain = mkdtempSync(join(tmpdir(), "ws-plain-"));
    const p1 = await startLocalWorkServer({ ledgerDir: plain, token: "t" });
    const p2 = await startLocalWorkServer({ ledgerDir: plain, token: "t" });
    expect(existsSync(join(plain, "run"))).toBe(false);
    await p1.close();
    await p2.close();
  });
});
