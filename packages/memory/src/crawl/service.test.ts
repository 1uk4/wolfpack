/** The crawl service: run.json lifecycle + restart, legacy run dirs, hub-first release target, no-target refusal, hub seams, hub-registry domains. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planCrawl, readPlan } from "./plan.js";
import { CrawlServiceError, createCrawlService, readRunRecord, releaseTarget, type CrawlRunner } from "./service.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-svc-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const src = tmp("src");
  mkdirSync(join(src, "docs"), { recursive: true });
  writeFileSync(join(src, "docs", "a.md"), "# A\nalpha\n");
  const crawlHome = join(tmp("home"), "crawls");
  mkdirSync(crawlHome, { recursive: true });
  const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: crawlHome });
  const planPath = join(sink.dir, "plan.yaml");
  return { crawlHome, planPath, plan: readPlan(planPath), runDir: sink.dir };
}

const holdRunner = () => {
  let n = 0;
  const gates: ((r: { ok: boolean; dir: string; cancelled?: boolean }) => void)[] = [];
  const runner: CrawlRunner = {
    run(planFile, o) {
      // the engine makes a run dir (a copy of the plan) under the sink base, or reuses the one being resumed
      const dir = o.runDir ?? join(o.sinkBase!, `run-${++n}`);
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, "plan.yaml"))) copyFileSync(planFile, join(dir, "plan.yaml"));
      o.onSink?.(dir);
      o.onProgress?.({ phase: "batch", batch: { topic: "docs", index: 0, total: 1, files: 1, stage: "extract", scanned: 0, observations: 0 } });
      return new Promise((resolve) => {
        gates.push(resolve);
        o.signal?.addEventListener("abort", () => resolve({ ok: false, cancelled: true, dir }));
      });
    },
    emit: () => {
      throw new Error("unexpected emit");
    },
  };
  return { runner, gates };
};

describe("run records (run.json)", () => {
  it("persists state/pid/progress while running and on finish; the finish is written even though updates are throttled", async () => {
    const f = fixture();
    const { runner, gates } = holdRunner();
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner });
    const r = svc.startRun({ planPath: f.planPath, concurrency: 3, wolf: "w" });
    const dir = r.runDir;
    expect(dir).toContain("run-1");
    const live = readRunRecord(dir)!;
    expect(live).toMatchObject({ version: 1, state: "running", pid: process.pid, concurrency: 3, wolf: "w", domain: "wolfpack" });
    expect(svc.listRuns()[0]).toMatchObject({ state: "running", live: true });
    gates[0]({ ok: true, dir });
    await svc.idle();
    const done = readRunRecord(dir)!;
    expect(done.state).toBe("done");
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(done.progress.rows[0].topic).toBe("docs");
  });

  it("a clashing run of the same plan is refused; stop aborts and records cancelled", async () => {
    const f = fixture();
    const { runner } = holdRunner();
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner });
    const { runDir } = svc.startRun({ planPath: f.planPath, wolf: "w" });
    expect(() => svc.startRun({ planPath: f.planPath })).toThrowError(CrawlServiceError);
    expect(svc.stopRun()).toEqual({ stopped: runDir });
    await svc.idle();
    expect(readRunRecord(runDir)!.state).toBe("cancelled");
    expect(svc.stopRun()).toMatchObject({ error: "none" });
  });

  it("after a restart an orphaned `running` record reads interrupted + resumable; a live foreign pid reads running-elsewhere", async () => {
    const f = fixture();
    const { runner } = holdRunner();
    const first = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner, pid: 111 });
    const dir = first.startRun({ planPath: f.planPath, wolf: "w" }).runDir;
    // "restart": a new service instance (empty abort cache) in a different process; the old pid is gone
    const second = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner, pid: 222, isAlive: () => false });
    const view = second.listRuns().find((r) => r.runDir === dir)!;
    expect(view).toMatchObject({ state: "interrupted", resumable: true, live: false });
    expect(second.status({ runDir: dir }).runs[0].state).toBe("interrupted");
    // a third process sees the old one still alive
    const third = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner, pid: 333, isAlive: (p) => p === 111 });
    expect(third.listRuns().find((r) => r.runDir === dir)!.state).toBe("running-elsewhere");
    expect(() => third.startRun({ planPath: f.planPath })).toThrowError(/already in progress/);
    // the interrupted run can be resumed in place: it is reserved again and recorded as this process's
    writeFileSync(join(dir, "observations.jsonl"), "");
    const out = second.outstanding(f.plan);
    expect(out.map((o) => o.runDir)).toEqual([dir]);
    const resumed = second.startRun({ planPath: f.planPath, resume: out[0] });
    expect(resumed).toMatchObject({ runDir: dir, resumed: true });
    expect(readRunRecord(dir)).toMatchObject({ state: "running", pid: 222, resumed: true });
    first.shutdown();
    second.shutdown();
  });

  it("a run dir without run.json (made before records existed) is listed as unrecorded, resumable when extraction began", () => {
    const f = fixture();
    expect(existsSync(join(f.runDir, "run.json"))).toBe(false);
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner: holdRunner().runner });
    expect(svc.listRuns()).toEqual([]); // a bare plan is not a run
    writeFileSync(join(f.runDir, "observations.jsonl"), "");
    expect(svc.listRuns()[0]).toMatchObject({ state: "unrecorded", resumable: true });
    writeFileSync(join(f.runDir, "history.json"), "{}");
    expect(svc.listRuns()[0]).toMatchObject({ state: "unrecorded", resumable: false });
    writeFileSync(join(f.runDir, "run.json"), "{ not json");
    expect(svc.listRuns()[0].state).toBe("unrecorded"); // a corrupt record degrades the same way
  });
});

describe("release target + refusal", () => {
  it("hub first, then KB_OPS, else none", () => {
    expect(releaseTarget({ WOLFPACK_HUB_URL: "http://h", KB_OPS: "/ops" }).kind).toBe("hub");
    expect(releaseTarget({ KB_OPS: "/ops" })).toEqual({ kind: "inbox", opsRoot: "/ops" });
    expect(releaseTarget({})).toEqual({ kind: "none" });
  });

  it("a real release with neither hub nor KB_OPS is refused before anything is emitted", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    let emits = 0;
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: {}, runner: { run: holdRunner().runner.run, emit: () => (emits++, undefined as never) } });
    await expect(svc.release(f.runDir, { wolf: "w" })).rejects.toMatchObject({ code: "no-target" });
    expect(emits).toBe(0);
  });

  it("an unfinished journey blocks a release; a dir outside the crawl home is not a run", async () => {
    const f = fixture();
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: { KB_OPS: tmp("ops") }, runner: holdRunner().runner });
    await expect(svc.release(f.runDir, { wolf: "w" })).rejects.toMatchObject({ code: "journey-missing" });
    await expect(svc.release(tmp("else"), { wolf: "w" })).rejects.toMatchObject({ code: "not-a-run" });
  });

  it("a release records itself in run.json and emitted.json; the hub URL is redacted in the record", async () => {
    const f = fixture();
    const { runner, gates } = holdRunner();
    const hubEnv = { WOLFPACK_HUB_URL: "https://u:p@hub.example", WOLFPACK_HUB_TOKEN: "tok-secret" };
    const svc = createCrawlService({
      crawlHome: f.crawlHome,
      env: hubEnv,
      runner: { ...runner, emit: () => ({ emitted: 2, skipped: 1, dest: "https://hub.example/v1/contributions", dir: f.runDir, contributions: [], delta: [] }) as never },
    });
    svc.startRun({ planPath: f.planPath, wolf: "w" });
    gates[0]({ ok: true, dir: f.runDir });
    await svc.idle();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    const r = await svc.release(f.runDir, { wolf: "w" });
    expect(r.via).toBe("hub");
    const rec = readRunRecord(f.runDir)!;
    expect(rec.release).toMatchObject({ emitted: 2, skipped: 1, via: "hub", dest: "https://hub.example/v1/contributions" });
    const raw = readFileSync(join(f.runDir, "run.json"), "utf-8") + readFileSync(join(f.runDir, "emitted.json"), "utf-8");
    expect(raw).not.toContain("tok-secret");
    expect(raw).not.toContain("u:p");
  });
});

describe("hub seams", () => {
  const jsonFetch = (routes: Record<string, { status: number; body?: unknown }>) =>
    (async (url: string) => {
      const path = new URL(url).pathname;
      const hit = routes[path];
      return hit ? Response.json(hit.body ?? {}, { status: hit.status }) : Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;

  it("declared domains come from the hub registry when there is no KB mirror; a local mirror wins", async () => {
    const f = fixture();
    const fetchStub = jsonFetch({ "/v1/registry/domains": { status: 200, body: { domains: [{ name: "wolfpack" }, { name: "snapjack" }] } } });
    const svc = createCrawlService({ crawlHome: f.crawlHome, env: { WOLFPACK_HUB_URL: "http://hub" }, runner: holdRunner().runner });
    expect(svc.declaredDomains()).toBeNull();
    // the service builds its hub target from env with the global fetch; stub it for this test
    const real = globalThis.fetch;
    globalThis.fetch = fetchStub;
    try {
      expect([...(await svc.refreshDomains())!].sort()).toEqual(["snapjack", "wolfpack"]);
      expect(svc.declaredDomains()!.has("snapjack")).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
    const local = createCrawlService({ crawlHome: f.crawlHome, env: { WOLFPACK_HUB_URL: "http://hub" }, runner: holdRunner().runner, localDomains: () => new Set(["only-local"]) });
    expect([...(await local.refreshDomains())!]).toEqual(["only-local"]);
    // an unreachable hub is "unknown" (null), not "no domains"
    const down = createCrawlService({ crawlHome: f.crawlHome, env: { WOLFPACK_HUB_URL: "http://127.0.0.1:1" }, runner: holdRunner().runner });
    expect(await down.refreshDomains()).toBeNull();
  });

  it("the receipts / check seams feature-detect: a hub without the routes yields undefined, with them the curated ids merge into the preview", async () => {
    const { readHubReceipts, checkHubContributions } = await import("./hub.js");
    const none = { baseUrl: "http://hub", fetch: jsonFetch({}) };
    expect(await readHubReceipts(none)).toBeUndefined();
    expect(await checkHubContributions(none, [{ denTopicId: "t" }])).toBeUndefined();
    const some = { baseUrl: "http://hub", fetch: jsonFetch({ "/v1/contributions/receipts": { status: 200, body: { curated: ["crawl-wolfpack-docs"] } } }) };
    expect([...(await readHubReceipts(some))!]).toEqual(["crawl-wolfpack-docs"]);
  });
});
