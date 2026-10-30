/** Guard-message whitelist, PATCH parity, body limits, close/write races and hook ordering for hubd work writes. */
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorEnvelopeSchema } from "@wolfpack/protocol";
import { appendWorkLedger, createWork, linkWork, loadWorkState, moveWork, setStanding, stageWork } from "@wolfpack/kb/client";
import { createHubServer as createRawHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";
import { OP, seedTokens } from "./testing/tokens.js";
import { HubError } from "./errors.js";
import { GUARD_MESSAGES, createWorkWriter, mapWorkError } from "./work-writes.js";

/** createHubServer on a data dir that already holds the test operator token (OP). */
const createHubServer = (o: Parameters<typeof createRawHubServer>[0]) => (seedTokens(o.dataDir), createRawHubServer(o));
const tmp: string[] = [];
const servers: HubServer[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-guards-"));
  tmp.push(d);
  return d;
};
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const start = async (dataDir: string, extra: Partial<Parameters<typeof createHubServer>[0]> = {}) => {
  const h = await createHubServer({ dataDir, ...extra });
  servers.push(h);
  return h;
};
const req = (h: HubServer, method: string, path: string, body?: unknown, headers: Record<string, string> = OP) =>
  fetch(h.url + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ledger = (dir: string) => readFileSync(join(dir, "ledger", "work-events.jsonl"), "utf8");
async function expectCode(res: Response, code: string) {
  const env = ErrorEnvelopeSchema.parse(await res.json());
  expect(env.code).toBe(code);
  expect(env.message).not.toMatch(/\/(Users|tmp|var)\//); // no absolute paths
  return env;
}
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

/** A seeded fixture plus an initiative with a feature, for guard triggers. */
function world(dir: string) {
  const f = seedFixture(dir);
  const roots = hubRoots(dir);
  const inbox = [...loadWorkState(roots).values()].find((w) => w.container)!.id as string;
  const init = createWork(roots, { kind: "initiative", domain: FIXTURE_DOMAIN, title: "Init", assignee: "1uk4" }).id as string;
  const feat2 = createWork(roots, { kind: "feature", domain: FIXTURE_DOMAIN, title: "Feat under init", assignee: "1uk4", partOf: init }).id as string;
  const bare = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "No criteria", assignee: "1uk4", partOf: f.feature.id }).id as string;
  return { roots, ...f, inbox, init, feat2, bare, t1: f.tasks[0]!, t2: f.tasks[1]! };
}

describe("guard-message whitelist (one case per kb message; a reword in kb fails here)", () => {
  const NOPE = "work-nope-zzzzzz";
  const cases: [string, string, string, (w: ReturnType<typeof world>) => unknown][] = [
    ["not found", "not_found", "not found", (w) => stageWork(w.roots, NOPE, "plan")],
    ["unknown parent", "invalid_request", "unknown parent", (w) => createWork(w.roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "x", assignee: "a", partOf: NOPE })],
    ["placement (create/move)", "invalid_request", "placement (create/move)", (w) => createWork(w.roots, { kind: "initiative", domain: FIXTURE_DOMAIN, title: "x", assignee: "a", partOf: w.feature.id })],
    ["placement (create/move)", "invalid_request", "placement (create/move)", (w) => moveWork(w.roots, w.t1, w.t2)],
    ["container cannot be moved", "invalid_request", "container cannot be moved", (w) => moveWork(w.roots, w.inbox, w.feature.id)],
    ["own parent", "invalid_request", "own parent", (w) => moveWork(w.roots, w.t1, w.t1)],
    ["standing (non-initiative)", "invalid_request", "standing (non-initiative)", (w) => setStanding(w.roots, w.feature.id, true)],
    ["standing at create", "invalid_request", "placement (create/move)", (w) => createWork(w.roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "x", assignee: "a", partOf: w.feature.id, standing: true })],
    ["dependency scope", "invalid_request", "dependency scope/cycle", (w) => linkWork(w.roots, w.t1, "depends_on", w.feature.id)],
    ["dependency self", "invalid_request", "dependency scope/cycle", (w) => linkWork(w.roots, w.t1, "depends_on", w.t1)],
    ["dependency cycle", "invalid_request", "dependency scope/cycle", (w) => {
      linkWork(w.roots, w.t1, "depends_on", w.t2);
      linkWork(w.roots, w.t2, "depends_on", w.t1);
    }],
    ["unsupported link rel", "invalid_request", "unsupported link rel", (w) => linkWork(w.roots, w.t1, "bogus", w.t2)],
    ["link target not found", "not_found", "not found", (w) => linkWork(w.roots, w.t1, "depends_on", NOPE)],
    ["invalid event", "invalid_request", "invalid event", (w) => stageWork(w.roots, w.t1, "bogus_stage")],
    ["not advanceable (criteria)", "not_ready", "not advanceable (criteria)", (w) => stageWork(w.roots, w.bare, "in_build")],
    ["never ships", "not_ready", "never ships", (w) => stageWork(w.roots, w.inbox, "shipped")],
  ];
  it.each(cases)("%s -> %s", (_label, code, guard, trigger) => {
    const w = world(mk());
    const err = thrown(() => trigger(w));
    const hit = GUARD_MESSAGES.find((g) => g.re.test(err.message));
    expect(hit?.name, `unmatched kb message: ${err.message}`).toBe(guard);
    const mapped = mapWorkError(err);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(err.message);
  });

  it("anything unmatched (or an fs error) is engine_error with a generic message and server-side detail", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const e of [new Error("boom /secret/path"), Object.assign(new Error("ENOENT /secret/path"), { code: "ENOENT" }), "str"]) {
      const m = mapWorkError(e);
      expect(m.code).toBe("engine_error");
      expect(m.message).toBe("internal hub error");
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(mapWorkError(new HubError("busy", "x")).code).toBe("busy");
  });
});

describe("HTTP guards, ops and ids", () => {
  it("cycle and scope guards over HTTP; link / unlink", async () => {
    const dir = mk();
    const w = world(dir);
    const hub = await start(dir);
    const patch = (id: string, b: unknown) => req(hub, "PATCH", `/v1/work/${id}`, b);
    await expectCode(await patch(w.t1, { link: { rel: "depends_on", target: w.feature.id } }), "invalid_request"); // scope
    expect((await patch(w.t1, { link: { rel: "depends_on", target: w.t2 } })).status).toBe(200);
    expect(((await (await req(hub, "GET", `/v1/work/${w.t1}/record`)).json()) as { dependsOn: string[] }).dependsOn).toEqual([w.t2]);
    await expectCode(await patch(w.t2, { link: { rel: "depends_on", target: w.t1 } }), "invalid_request"); // cycle
    expect((await patch(w.t1, { unlink: { rel: "depends_on", target: w.t2 } })).status).toBe(200);
    expect(((await (await req(hub, "GET", `/v1/work/${w.t1}/record`)).json()) as { dependsOn: string[] }).dependsOn).toEqual([]);
  });

  it("schedule, standing, and an operator body write", async () => {
    const dir = mk();
    const w = world(dir);
    const hub = await start(dir);
    const patch = (id: string, b: unknown, h?: Record<string, string>) => req(hub, "PATCH", `/v1/work/${id}`, b, h);
    const sched = await patch(w.t1, { schedule: { scheduledFor: "2026-11-01 09:00", durationMinutes: 30 } });
    expect(sched.status).toBe(200);
    await expectCode(await patch(w.t2, { schedule: { scheduledFor: "tomorrow" } }), "invalid_request");
    expect(((await sched.json()) as { item: { scheduledFor?: string } }).item.scheduledFor).toBe("2026-11-01 09:00");
    const unsched = await patch(w.t1, { schedule: { scheduledFor: null } });
    expect(((await unsched.json()) as { item: { scheduledFor?: string | null } }).item.scheduledFor ?? null).toBeNull();
    expect(((await (await patch(w.init, { standing: true })).json()) as { item: { standing?: boolean } }).item.standing).toBe(true);
    await expectCode(await patch(w.feature.id, { standing: true }), "invalid_request");
    expect((await patch(w.feature.id, { body: "## Plan\n\nRewritten.\n" })).status).toBe(200);
    expect(((await (await req(hub, "GET", `/v1/work/${w.feature.id}/record`)).json()) as { plan: string }).plan).toContain("Rewritten.");
  });

  it("DELETE cascades to children", async () => {
    const dir = mk();
    const w = world(dir);
    const hub = await start(dir);
    const del = (await (await req(hub, "DELETE", `/v1/work/${w.feature.id}`)).json()) as { deleted: string[] };
    expect(del.deleted.sort()).toEqual([w.feature.id, ...w.tasks, w.graduated, w.bare].sort());
    expect((await req(hub, "GET", `/v1/work/${w.t1}/record`)).status).toBe(404);
  });

  it("invalid ids are rejected on every id route", async () => {
    const hub = await start(mk());
    for (const [m, p, b] of [["PATCH", "/v1/work/..%2Fetc", { note: "x" }], ["DELETE", "/v1/work/not-an-id", undefined], ["POST", "/v1/work/x/graduate", undefined], ["GET", "/v1/work/zz/record", undefined]] as const) {
      await expectCode(await req(hub, m, p, b), "invalid_request");
    }
  });
});

describe("PATCH parity", () => {
  it("empty strings, moveTo '', unknown keys and multiple fields are invalid_request; moveTo:null un-parents", async () => {
    const dir = mk();
    const w = world(dir);
    const hub = await start(dir);
    const patch = (b: unknown) => req(hub, "PATCH", `/v1/work/${w.feat2}`, b);
    for (const b of [{ stage: "" }, { note: "" }, { title: "" }, { assignee: "" }, { moveTo: "" }, { bogus: 1 }, { note: "a", title: "b" }, {}]) {
      await expectCode(await patch(b), "invalid_request");
    }
    expect(((await (await patch({ moveTo: null })).json()) as { item: { partOf: string | null } }).item.partOf).toBeNull();
  });
});

describe("request bodies", () => {
  it("auth runs before the body is read (a bad token with a bad body is 401)", async () => {
    const hub = await start(mk());
    const res = await fetch(hub.url + "/v1/work", { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{not json" });
    await expectCode(res, "unauthorized");
  });

  it("oversized (Content-Length and chunked) and malformed bodies are invalid_request", async () => {
    const hub = await start(mk());
    const big = JSON.stringify({ kind: "idea", domain: FIXTURE_DOMAIN, title: "x".repeat(3 * 1024 * 1024), assignee: "a" });
    const sized = await fetch(hub.url + "/v1/work", { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: big });
    expect((await expectCode(sized, "invalid_request")).message).toMatch(/too large/);
    const chunked = await fetch(hub.url + "/v1/work", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OP },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }),
      // @ts-expect-error node fetch needs duplex for streams
      duplex: "half",
    });
    expect((await expectCode(chunked, "invalid_request")).message).toMatch(/too large/);
    const bad = await fetch(hub.url + "/v1/work", { method: "POST", headers: { ...OP }, body: "{not json" });
    expect((await expectCode(bad, "invalid_request")).message).toMatch(/valid JSON/);
  });

  it("a stalled body times out", async () => {
    const hub = await start(mk(), { bodyTimeoutMs: 150 });
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(hub.url + "/v1/work", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100", ...OP } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.write('{"kind":');
    });
    expect(status).toBe(400);
  });
});

describe("close vs writes", () => {
  it("an in-flight write commits and answers; one arriving after close started is rejected busy; the lock is then freed", async () => {
    const dir = mk();
    let release!: () => void;
    let entered!: () => void;
    const inGate = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    let gated = false;
    const hub = await createHubServer({
      dataDir: dir,
      writeGate: async () => {
        if (gated) return;
        gated = true;
        entered();
        await held;
      },
    });
    const url = new URL(hub.url);
    const mkBody = (title: string) => JSON.stringify({ kind: "idea", domain: FIXTURE_DOMAIN, title, assignee: "a" });
    const aRes = fetch(hub.url + "/v1/work", { method: "POST", headers: { "Content-Type": "application/json", ...OP }, body: mkBody("in-flight") });
    await inGate; // A is inside the write queue

    // B: connected with headers + part of its body sent, so it is a live request when close starts.
    const bBody = mkBody("too-late");
    const bDone = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({ host: url.hostname, port: url.port, path: "/v1/work", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bBody)), ...OP } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      });
      r.on("error", reject);
      r.write(bBody.slice(0, 10));
      setTimeout(() => {
        // after close has started:
        closing = hub.close();
        setTimeout(() => {
          r.end(bBody.slice(10));
          setTimeout(release, 20);
        }, 50);
      }, 50);
    });
    let closing: Promise<void> = Promise.resolve();
    const b = await bDone;
    const a = await aRes;
    await closing;
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    const env = ErrorEnvelopeSchema.parse(JSON.parse(b.body));
    expect(env).toMatchObject({ code: "busy", retryable: true });
    const l = ledger(dir);
    expect(l).toContain("in-flight");
    expect(l).not.toContain("too-late");
    // lock released: a new hub can start on the same dir
    servers.push(await createHubServer({ dataDir: dir }));
  });
});

describe("post-append hook", () => {
  it("fires with the appended events (in order) even when the op throws after appending, and never masks the write's error or result", async () => {
    const dir = mk();
    const w = world(dir);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = createWorkWriter({ roots: w.roots, release: () => {} });
    const seen: string[][] = [];
    writer.onAppended(({ events }) => seen.push(events.map((e) => `${e.type}:${e.id}`)));
    await expect(
      writer.write({ id: "x", kind: "operator" }, () => {
        appendWorkLedger(w.roots, [
          { type: "work.noted", id: w.t1, at: "2026-10-29 10:00", text: "first" } as never,
          { type: "work.noted", id: w.t1, at: "2026-10-29 10:01", text: "second" } as never,
        ]);
        throw new Error("work item " + w.t1 + " not found");
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(seen).toEqual([[`work.noted:${w.t1}`, `work.noted:${w.t1}`]]);
    // a throwing listener does not change the write's result
    writer.onAppended(() => {
      throw new Error("listener boom");
    });
    await expect(writer.write({ id: "x", kind: "operator" }, () => { appendWorkLedger(w.roots, [{ type: "work.noted", id: w.t1, at: "2026-10-29 10:02", text: "third" } as never]); return 42; })).resolves.toBe(42);
    expect(log).toHaveBeenCalled();
    // writes after close are refused; the lock is released exactly once, after the queue drained
    let releases = 0;
    const w2 = createWorkWriter({ roots: w.roots, release: () => void releases++ });
    const pending = w2.write({ id: "x", kind: "operator" }, () => "ok");
    const closed = w2.close();
    await expect(w2.write({ id: "x", kind: "operator" }, () => "late")).rejects.toMatchObject({ code: "busy" });
    await expect(pending).resolves.toBe("ok");
    await closed;
    await w2.close();
    expect(releases).toBe(1);
  });
});

describe("startup failure and probe failure", () => {
  it("a createHubServer that fails after acquiring the lock releases it synchronously: an immediate retry succeeds", async () => {
    const dir = mk();
    const other = mk();
    const blocker = await start(other); // holds a port
    await expect(createHubServer({ dataDir: dir, port: blocker.port })).rejects.toThrow(/EADDRINUSE/);
    servers.push(await createHubServer({ dataDir: dir })); // no wait between the reject and the retry
  });

  it("a non-ENOENT stat failure skips the hook diff (no replay of the ledger) and does not affect the write", async () => {
    const dir = mk();
    // `ledger` is a file, so statting <dir>/ledger/work-events.jsonl fails with ENOTDIR (not ENOENT).
    writeFileSync(join(dir, "ledger"), "x");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = createWorkWriter({ roots: hubRoots(dir), release: () => {} });
    const heard = vi.fn();
    writer.onAppended(heard);
    await expect(writer.write({ id: "x", kind: "operator" }, () => 7)).resolves.toBe(7);
    expect(heard).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});
