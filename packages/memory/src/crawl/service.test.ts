/**
 * The crawl service: run.json lifecycle + restart, identity/heartbeat staleness, cross-process reservation, release guards and
 * locks, secrets in records, hub-first release target, hub seams, hub-registry domains (fail closed).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCrawlToHub } from "./hub.js";
import { acquireLock } from "./lock.js";
import { planCrawl, readPlan } from "./plan.js";
import { readReleaseState } from "./runs.js";
import { CANCEL_MARKER, CrawlServiceError, createCrawlService, readRunRecord, releaseTarget, type CrawlRunner, type CrawlServiceOptions } from "./service.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-svc-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(folders = 1) {
  const src = tmp("src");
  for (let i = 0; i < folders; i++) {
    mkdirSync(join(src, `docs${i}`), { recursive: true });
    writeFileSync(join(src, `docs${i}`, "a.md"), `# A${i}\nalpha\n`);
  }
  const crawlHome = join(tmp("home"), "crawls");
  mkdirSync(crawlHome, { recursive: true });
  const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: crawlHome });
  const planPath = join(sink.dir, "plan.yaml");
  return { crawlHome, planPath, plan: readPlan(planPath), runDir: sink.dir };
}
/** Make the fixture's plan dir a finished run (topics + journey) so emitCrawl can render it. */
function finish(f: ReturnType<typeof fixture>, dir = f.runDir) {
  writeFileSync(join(dir, "topics.json"), JSON.stringify(f.plan.batches.map((b, i) => [b.topic, { title: `T${i}`, summary: "s", body: `body text ${i}`, events: [] }])));
  writeFileSync(join(dir, "history.json"), JSON.stringify({ title: "H", summary: "s", body: "history body", events: [] }));
}

const holdRunner = (opts: { sink?: boolean } = {}) => {
  let n = 0;
  const gates: ((r: { ok: boolean; dir: string; cancelled?: boolean; failures?: string[] }) => void)[] = [];
  const runner: CrawlRunner = {
    run(planFile, o) {
      // the engine makes a run dir (a copy of the plan) under the sink base, or reuses the one being resumed
      const dir = o.runDir ?? join(o.sinkBase!, `run-${++n}`);
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, "plan.yaml"))) copyFileSync(planFile, join(dir, "plan.yaml"));
      if (opts.sink !== false) o.onSink?.(dir);
      o.onProgress?.({ phase: "batch", batch: { topic: "docs0", index: 0, total: 1, files: 1, stage: "extract", scanned: 0, observations: 0 } });
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
const ID = { host: "h1", boot: "b1" };
const svcOf = (f: ReturnType<typeof fixture>, o: Partial<CrawlServiceOptions> = {}) =>
  createCrawlService({ crawlHome: f.crawlHome, env: {}, runner: holdRunner().runner, identity: ID, heartbeatMs: 0, ...o });
const emitStub = (extra: Partial<CrawlRunner> = {}): CrawlRunner => ({
  run: holdRunner().runner.run,
  emit: () => ({ emitted: 2, skipped: 0, dest: "inbox", dir: "", contributions: [], delta: [] }) as never,
  ...extra,
});

describe("run records (run.json)", () => {
  it("persists state/pid/identity/progress while running and on finish", async () => {
    const f = fixture();
    const { runner, gates } = holdRunner();
    const svc = svcOf(f, { runner });
    const r = await svc.startRun({ planPath: f.planPath, concurrency: 3, wolf: "w" });
    const dir = r.runDir;
    expect(dir).toContain("run-1");
    expect(readRunRecord(dir)).toMatchObject({ version: 1, state: "running", pid: process.pid, host: "h1", boot: "b1", concurrency: 3, wolf: "w", domain: "wolfpack" });
    expect(svc.listRuns()[0]).toMatchObject({ state: "running", live: true });
    gates[0]({ ok: true, dir });
    await svc.idle();
    const done = readRunRecord(dir)!;
    expect(done.state).toBe("done");
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(done.progress.rows[0].topic).toBe("docs0");
    expect(readdirSync(f.crawlHome).filter((n) => n.startsWith(".reserve-"))).toEqual([]);
  });

  it("a clashing run of the same plan is refused; stop aborts and records cancelled", async () => {
    const f = fixture();
    const svc = svcOf(f);
    const { runDir } = await svc.startRun({ planPath: f.planPath, wolf: "w" });
    await expect(svc.startRun({ planPath: f.planPath })).rejects.toBeInstanceOf(CrawlServiceError);
    expect(svc.stopRun()).toEqual({ stopped: runDir });
    await svc.idle();
    expect(readRunRecord(runDir)!.state).toBe("cancelled");
    expect(svc.stopRun()).toMatchObject({ error: "none" });
  });

  it("a run dir without run.json is unrecorded; a corrupt or progress-less run.json is `corrupt` (not resumable), kept as run.json.corrupt", () => {
    const f = fixture();
    const svc = svcOf(f);
    expect(svc.listRuns()).toEqual([]); // a bare plan is not a run
    writeFileSync(join(f.runDir, "observations.jsonl"), "");
    expect(svc.listRuns()[0]).toMatchObject({ state: "unrecorded", resumable: true });
    writeFileSync(join(f.runDir, "topics.json"), JSON.stringify(f.plan.batches.map((b) => [b.topic, {}])));
    writeFileSync(join(f.runDir, "history.json"), "{}");
    expect(svc.listRuns()[0]).toMatchObject({ state: "unrecorded", resumable: false }); // every batch landed and the journey is written
    writeFileSync(join(f.runDir, "run.json"), "{ not json");
    expect(svc.listRuns()[0]).toMatchObject({ state: "corrupt", resumable: false });
    expect(readFileSync(join(f.runDir, "run.json.corrupt"), "utf-8")).toBe("{ not json");
    rmSync(join(f.runDir, "run.json.corrupt"));
    // valid JSON but no progress snapshot / rows is just as unusable
    writeFileSync(join(f.runDir, "run.json"), JSON.stringify({ version: 1, state: "running", pid: 1, runDir: f.runDir }));
    expect(svc.listRuns()[0].state).toBe("corrupt");
    writeFileSync(join(f.runDir, "run.json"), JSON.stringify({ version: 1, state: "done", pid: 1, runDir: f.runDir, progress: { rows: "nope" } }));
    expect(svc.listRuns()[0].state).toBe("corrupt");
    expect(readRunRecord(f.runDir)).toBeUndefined();
  });

  it("a sync-throwing runner on resume records state failed (with the secret scrubbed) and frees the reservation; a fresh sync throw leaves nothing behind", async () => {
    const f = fixture();
    const ok = holdRunner();
    const first = svcOf(f, { runner: ok.runner, pid: 111 });
    const dir = (await first.startRun({ planPath: f.planPath })).runDir;
    void first; // its process "dies": the record stays `running`
    writeFileSync(join(dir, "observations.jsonl"), "");
    const boom: CrawlRunner = {
      run: () => {
        throw new Error("no key: Bearer abc123def and sk-live1234567 tok-secret-xyz");
      },
      emit: ok.runner.emit,
    };
    const svc = svcOf(f, { runner: boom, pid: 222, isAlive: () => false, env: { WOLFPACK_HUB_TOKEN: "tok-secret-xyz" } });
    const out = svc.outstanding(f.plan);
    expect(out.map((o) => o.runDir)).toEqual([dir]);
    await expect(svc.startRun({ planPath: f.planPath, resume: out[0] })).rejects.toMatchObject({ code: "start-failed" });
    const rec = readRunRecord(dir)!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("no key");
    expect(JSON.stringify(rec)).not.toMatch(/abc123def|sk-live|tok-secret/);
    expect(readdirSync(f.crawlHome).filter((n) => n.startsWith(".reserve-"))).toEqual([]);
    // fresh: nothing recorded, nothing reserved, can start again
    await expect(svc.startRun({ planPath: f.planPath })).rejects.toMatchObject({ code: "start-failed" });
    expect(readdirSync(f.crawlHome).filter((n) => n.startsWith(".reserve-"))).toEqual([]);
  });

  it("secrets in a failed run's error and in row errors never reach run.json", async () => {
    const f = fixture();
    let reject!: (e: Error) => void;
    const runner: CrawlRunner = {
      run: (planFile, o) => {
        const dir = join(o.sinkBase!, "run-x");
        mkdirSync(dir, { recursive: true });
        copyFileSync(planFile, join(dir, "plan.yaml"));
        o.onSink?.(dir);
        o.onProgress?.({ phase: "batch", batch: { topic: "docs0", index: 0, total: 1, files: 1, stage: "error", error: "401 Bearer zzz-secret-1 https://u:p@x.example/?token=qqq" } });
        return new Promise((_, rj) => (reject = rj));
      },
      emit: () => {
        throw new Error("x");
      },
    };
    const svc = svcOf(f, { runner, env: { ANTHROPIC_API_KEY: "sk-ant-api03-REALKEY" } });
    const { runDir } = await svc.startRun({ planPath: f.planPath });
    reject(new Error("auth failed for sk-ant-api03-REALKEY"));
    await svc.idle();
    const raw = readFileSync(join(runDir, "run.json"), "utf-8");
    expect(JSON.parse(raw).state).toBe("failed");
    expect(raw).not.toMatch(/zzz-secret|REALKEY|u:p|qqq/);
  });
});

describe("process identity, heartbeat, takeover", () => {
  /** A run.json as another process would leave it. */
  async function foreign(f: ReturnType<typeof fixture>, patch: Record<string, unknown>) {
    const ok = holdRunner();
    const owner = svcOf(f, { runner: ok.runner, pid: 111 });
    const dir = (await owner.startRun({ planPath: f.planPath, wolf: "w" })).runDir; // never settled: the owner "dies"
    const rec = readRunRecord(dir)!;
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...rec, ...patch }));
    return dir;
  }

  it("after a restart an orphaned `running` record reads interrupted + resumable; a live foreign pid with a fresh heartbeat reads running-elsewhere", async () => {
    const f = fixture();
    const dir = await foreign(f, {});
    writeFileSync(join(dir, "observations.jsonl"), "");
    const second = svcOf(f, { pid: 222, isAlive: () => false });
    expect(second.listRuns().find((r) => r.runDir === dir)).toMatchObject({ state: "interrupted", resumable: true, live: false });
    const third = svcOf(f, { pid: 333, isAlive: (p) => p === 111 });
    expect(third.listRuns().find((r) => r.runDir === dir)!.state).toBe("running-elsewhere");
    await expect(third.startRun({ planPath: f.planPath })).rejects.toThrowError(/already in progress/);
    // resume in place: reserved again and recorded as this process's
    const out = second.outstanding(f.plan);
    expect(out.map((o) => o.runDir)).toEqual([dir]);
    expect(await second.startRun({ planPath: f.planPath, resume: out[0] })).toMatchObject({ runDir: dir, resumed: true });
    expect(readRunRecord(dir)).toMatchObject({ state: "running", pid: 222, resumed: true });
    second.shutdown();
  });

  it("pid reuse: a different boot id or host is interrupted even when the pid is alive and the heartbeat fresh", async () => {
    const f = fixture();
    const dirBoot = await foreign(f, { boot: "old-boot" });
    const svc = svcOf(f, { pid: 333, isAlive: () => true });
    expect(svc.listRuns().find((r) => r.runDir === dirBoot)!.state).toBe("interrupted");
    // another host: the pid cannot be checked, so a FRESH heartbeat means running-elsewhere, a stale one interrupted
    writeFileSync(join(dirBoot, "run.json"), JSON.stringify({ ...readRunRecord(dirBoot)!, boot: "b1", host: "other-host", updatedAt: Date.now() }));
    expect(svc.listRuns().find((r) => r.runDir === dirBoot)!.state).toBe("running-elsewhere");
    writeFileSync(join(dirBoot, "run.json"), JSON.stringify({ ...readRunRecord(dirBoot)!, updatedAt: Date.now() - 10 * 60_000 }));
    expect(svc.listRuns().find((r) => r.runDir === dirBoot)!.state).toBe("interrupted");
    // an "unknown" boot id never proves a difference
    writeFileSync(join(dirBoot, "run.json"), JSON.stringify({ ...readRunRecord(dirBoot)!, host: ID.host, boot: "unknown", updatedAt: Date.now() }));
    expect(svc.listRuns().find((r) => r.runDir === dirBoot)!.state).toBe("running-elsewhere");
  });

  it("a stale heartbeat reads interrupted even when the pid is alive; the heartbeat keeps a live run fresh", async () => {
    const f = fixture();
    let t = 1_000_000;
    const ok = holdRunner();
    const owner = svcOf(f, { runner: ok.runner, pid: 111, now: () => t, staleMs: 45_000 });
    const dir = (await owner.startRun({ planPath: f.planPath })).runDir;
    const peer = svcOf(f, { pid: 222, isAlive: () => true, now: () => t, staleMs: 45_000 });
    t += 30_000;
    expect(peer.listRuns().find((r) => r.runDir === dir)!.state).toBe("running-elsewhere");
    owner.heartbeat(); // the owner touches updatedAt
    t += 30_000;
    expect(readRunRecord(dir)!.updatedAt).toBe(1_030_000);
    expect(peer.listRuns().find((r) => r.runDir === dir)!.state).toBe("running-elsewhere"); // 30 s since the beat
    t += 30_000; // now 60 s since the last beat: the owner is wedged or gone
    expect(peer.listRuns().find((r) => r.runDir === dir)!.state).toBe("interrupted");
    owner.shutdown();
  });

  it("stop takes over a stale record (interrupted → cancelled); a live foreign record needs force", async () => {
    const f = fixture();
    const dir = await foreign(f, {});
    const live = svcOf(f, { pid: 333, isAlive: () => true });
    expect(live.stopRun(dir)).toMatchObject({ error: "foreign", pid: 111 });
    // force on a live owner never rewrites its record: it leaves a cancel marker the owner honours at its heartbeat
    expect(live.stopRun(dir, { force: true })).toEqual({ stopped: dir, requested: true });
    expect(readRunRecord(dir)).toMatchObject({ state: "running" });
    expect(existsSync(join(dir, CANCEL_MARKER))).toBe(true);

    const f2 = fixture();
    const dir2 = await foreign(f2, {});
    const dead = svcOf(f2, { pid: 333, isAlive: () => false });
    expect(dead.stopRun(dir2)).toEqual({ stopped: dir2, takenOver: true });
    expect(readRunRecord(dir2)!.state).toBe("cancelled");
  });
});

describe("cross-process reservation", () => {
  it("two services (two pids) sharing one crawl home starting the same plan at once: exactly one wins, before any run dir exists", async () => {
    const f = fixture();
    // the runner is slow to create its sink: only the on-disk reservation can stop the second start
    const a = svcOf(f, { runner: holdRunner({ sink: false }).runner, pid: 111, isAlive: () => true });
    const b = svcOf(f, { runner: holdRunner({ sink: false }).runner, pid: 222, isAlive: () => true });
    const results = await Promise.allSettled([a.startRun({ planPath: f.planPath }), b.startRun({ planPath: f.planPath })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "clash" });
    expect(readdirSync(f.crawlHome).filter((n) => n.startsWith(".reserve-"))).toHaveLength(1);
    a.shutdown();
    b.shutdown();
  });

  it("once the sink exists the reservation is replaced by run.json (running-elsewhere); a stale reservation (dead owner) is taken over", async () => {
    const f = fixture();
    const a = svcOf(f, { pid: 111, isAlive: () => true });
    await a.startRun({ planPath: f.planPath });
    expect(readdirSync(f.crawlHome).filter((n) => n.startsWith(".reserve-"))).toEqual([]);
    const b = svcOf(f, { pid: 222, isAlive: () => true });
    await expect(b.startRun({ planPath: f.planPath })).rejects.toMatchObject({ code: "clash" });
    a.shutdown();

    const g = fixture();
    const owner = svcOf(g, { runner: holdRunner({ sink: false }).runner, pid: 111, isAlive: () => true });
    await owner.startRun({ planPath: g.planPath });
    const deadOwner = svcOf(g, { pid: 222, isAlive: (p) => p !== 111 });
    await expect(deadOwner.startRun({ planPath: g.planPath })).resolves.toBeTruthy();
    owner.shutdown();
    deadOwner.shutdown();
  });
});

describe("release target + guards", () => {
  it("hub first, then KB_OPS, else none", () => {
    expect(releaseTarget({ WOLFPACK_HUB_URL: "http://h", KB_OPS: "/ops" }).kind).toBe("hub");
    expect(releaseTarget({ KB_OPS: "/ops" })).toEqual({ kind: "inbox", opsRoot: "/ops" });
    expect(releaseTarget({})).toEqual({ kind: "none" });
  });

  it("a real release with neither hub nor KB_OPS is refused before anything is emitted; it also needs confirmed: true", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    let emits = 0;
    const svc = svcOf(f, { runner: emitStub({ emit: () => (emits++, undefined as never) }) });
    await expect(svc.release(f.runDir, { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "no-target" });
    await expect(svc.release(f.runDir, { wolf: "w" })).rejects.toMatchObject({ code: "not-confirmed" });
    expect(emits).toBe(0);
  });

  it("an unfinished journey blocks a release; a dir outside the crawl home is not a run", async () => {
    const f = fixture();
    const svc = svcOf(f, { env: { KB_OPS: tmp("ops") } });
    await expect(svc.release(f.runDir, { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "journey-missing" });
    await expect(svc.release(tmp("else"), { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "not-a-run" });
  });

  it("refuses running (held), running-elsewhere, interrupted, failed, cancelled, gate-failed and corrupt runs — in release AND preview; an unrecorded dir with history still releases", async () => {
    const f = fixture();
    const ops = tmp("ops");
    const ok = holdRunner();
    const owner = svcOf(f, { runner: { ...emitStub(), run: ok.runner.run }, env: { KB_OPS: ops }, pid: 111, isAlive: () => true, localDomains: () => new Set(["wolfpack"]) });
    const dir = (await owner.startRun({ planPath: f.planPath, wolf: "w" })).runDir;
    writeFileSync(join(dir, "history.json"), "{}");
    const peer = svcOf(f, { runner: emitStub(), env: { KB_OPS: ops }, pid: 222, isAlive: () => true });
    const tryRelease = (s: typeof owner) => s.release(dir, { wolf: "w", confirmed: true });
    const tryPreview = (s: typeof owner) => s.previewRelease(dir, { wolf: "w" });
    // held + running here
    await expect(tryRelease(owner)).rejects.toMatchObject({ code: "run-active" });
    await expect(tryPreview(owner)).rejects.toMatchObject({ code: "run-active" });
    expect(owner.releasable(dir)).toMatchObject({ ok: false, code: "run-active" });
    // running in another live process
    await expect(tryRelease(peer)).rejects.toMatchObject({ code: "run-active" });
    // interrupted
    const dead = svcOf(f, { runner: emitStub(), env: { KB_OPS: ops }, pid: 333, isAlive: () => false });
    await expect(tryRelease(dead)).rejects.toMatchObject({ code: "run-active" });
    owner.shutdown();
    // recorded terminal states
    const base = readRunRecord(dir)!;
    for (const [state, code] of [["failed", "run-not-done"], ["cancelled", "run-not-done"], ["gate-failed", "run-not-done"]] as const) {
      writeFileSync(join(dir, "run.json"), JSON.stringify({ ...base, state }));
      await expect(tryRelease(dead)).rejects.toMatchObject({ code });
      await expect(tryPreview(dead)).rejects.toMatchObject({ code });
    }
    writeFileSync(join(dir, "run.json"), "garbage");
    await expect(tryRelease(dead)).rejects.toMatchObject({ code: "corrupt" });
    // done releases; so does an unrecorded dir (a run from before records existed) with a journey
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ...base, state: "done" }));
    await expect(tryRelease(dead)).resolves.toMatchObject({ via: "inbox" });
    rmSync(join(dir, "run.json"));
    await expect(tryRelease(dead)).resolves.toMatchObject({ via: "inbox" });
  });

  it("concurrent releases of one dir: the second is refused in-process (releasing Set) and across processes (release.lock); the lock is removed afterwards", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let emits = 0;
    const slow = emitStub({
      emit: async () => {
        emits++;
        await gate;
        return { emitted: 1, skipped: 0, dest: "inbox", dir: "", contributions: [], delta: [] } as never;
      },
    });
    const env = { KB_OPS: tmp("ops") };
    const a = svcOf(f, { runner: slow, env, pid: 111, isAlive: () => true });
    const b = svcOf(f, { runner: slow, env, pid: 222, isAlive: () => true });
    const first = a.release(f.runDir, { wolf: "w", confirmed: true });
    await expect(a.release(f.runDir, { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "releasing" }); // same process
    await expect(b.release(f.runDir, { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "releasing" }); // other process: the lock file
    expect(existsSync(join(f.runDir, "release.lock"))).toBe(true);
    open();
    await first;
    expect(emits).toBe(1);
    expect(existsSync(join(f.runDir, "release.lock"))).toBe(false);
    await expect(b.release(f.runDir, { wolf: "w", confirmed: true })).resolves.toBeTruthy(); // free again
    // a stale lock (dead owner) does not block
    writeFileSync(join(f.runDir, "release.lock"), JSON.stringify({ pid: 999, host: "h1", boot: "b1", at: Date.now() }));
    const c = svcOf(f, { runner: slow, env, pid: 333, isAlive: () => false });
    await expect(c.release(f.runDir, { wolf: "w", confirmed: true })).resolves.toBeTruthy();
  });

  it("a release goes through the held record (not a read-modify-write over it) and records into run.json + emitted.json; a re-release keeps the first record; the hub URL/token never appear", async () => {
    const f = fixture();
    const { runner, gates } = holdRunner();
    let emitted = 2;
    const env = { WOLFPACK_HUB_URL: "https://u:p@hub.example", WOLFPACK_HUB_TOKEN: "tok-secret" };
    vi.stubGlobal("fetch", async () => Response.json({ domains: [{ name: "wolfpack" }] }));
    const svc = svcOf(f, { runner: { ...runner, emit: () => ({ emitted, skipped: 1, dest: "https://hub.example/v1/contributions", dir: f.runDir, contributions: [], delta: [] }) as never }, env });
    const { runDir } = await svc.startRun({ planPath: f.planPath, wolf: "w" });
    gates[0]({ ok: true, dir: runDir });
    await svc.idle();
    writeFileSync(join(runDir, "history.json"), "{}");
    const r1 = await svc.release(runDir, { wolf: "w", confirmed: true });
    expect(r1).toMatchObject({ via: "hub", warnings: [] });
    emitted = 0;
    await svc.release(runDir, { wolf: "w", confirmed: true });
    const rec = readRunRecord(runDir)!;
    expect(rec.state).toBe("done"); // the held record was updated in place
    expect(rec.release).toMatchObject({ emitted: 2, via: "hub", dest: "https://hub.example/v1/contributions" });
    expect(rec.releases!.map((x) => x.emitted)).toEqual([2, 0]);
    const em = JSON.parse(readFileSync(join(runDir, "emitted.json"), "utf-8"));
    expect(em).toMatchObject({ emitted: 2, via: "hub" });
    expect(em.releases.map((x: { emitted: number }) => x.emitted)).toEqual([2, 0]);
    const raw = readFileSync(join(runDir, "run.json"), "utf-8") + JSON.stringify(em);
    expect(raw).not.toMatch(/tok-secret|u:p/);
  });

  it("a failed emitted.json write is surfaced as a warning on the result, not swallowed", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    mkdirSync(join(f.runDir, "emitted.json")); // a directory in the way: the write cannot succeed
    const svc = svcOf(f, { runner: emitStub(), env: { KB_OPS: tmp("ops") } });
    const r = await svc.release(f.runDir, { wolf: "w", confirmed: true });
    expect(r.warnings.join(" ")).toMatch(/could not write emitted.json/);
  });
});

describe("a release where the hub refuses every entry", () => {
  it("does not count as released: no emitted.json, no run.json release, preview shows the refusal (refs only); a later good release clears it", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    const refusedAll = emitStub({ emit: () => ({ emitted: 0, skipped: 0, dest: "http://hub/v1/contributions", dir: "", contributions: [], delta: [], rejected: [{ denTopicId: "crawl-wolfpack-secretish", message: "hub rejected the contribution (400): possible secret" }] }) as never });
    const svc = svcOf(f, { runner: refusedAll, env: { WOLFPACK_HUB_URL: "http://hub" } });
    const r = await svc.release(f.runDir, { wolf: "w", confirmed: true });
    expect(r.emitted).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/NOT released: the hub refused entry [0-9a-f]{8}/);
    expect(r.warnings.join(" ")).not.toContain("crawl-wolfpack-secretish");
    expect(existsSync(join(f.runDir, "emitted.json"))).toBe(false);
    const pv = await svc.previewRelease(f.runDir, { wolf: "w" }).catch(() => undefined);
    const state = readReleaseState(f.runDir, undefined, "w", []);
    expect(state.releasedAt).toBeUndefined();
    expect(state.refused).toMatchObject({ count: 1 });
    expect(state.refused!.refs[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(state)).not.toContain("secretish");
    expect(pv === undefined || pv.release.releasedAt === undefined).toBe(true);
    // a later release that sends something is a release and clears the refusal note
    const good = svcOf(f, { runner: emitStub(), env: { KB_OPS: tmp("ops") } });
    await good.release(f.runDir, { wolf: "w", confirmed: true });
    expect(existsSync(join(f.runDir, "emitted.json"))).toBe(true);
    expect(readReleaseState(f.runDir, undefined, "w", []).refused).toBeUndefined();
  });

  it("a partial release (some sent, some refused) is a release and records refused + refs on the record", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    const partial = emitStub({ emit: () => ({ emitted: 1, skipped: 0, dest: "x", dir: "", contributions: [], delta: [], rejected: [{ denTopicId: "t1", message: "m" }] }) as never });
    const svc = svcOf(f, { runner: partial, env: { WOLFPACK_HUB_URL: "http://hub" } });
    await svc.release(f.runDir, { wolf: "w", confirmed: true });
    const em = JSON.parse(readFileSync(join(f.runDir, "emitted.json"), "utf-8"));
    expect(em).toMatchObject({ emitted: 1, refused: 1 });
    expect(em.refusedRefs).toHaveLength(1);
    expect(readReleaseState(f.runDir, undefined, "w", []).refused).toMatchObject({ count: 1 });
  });
});

describe("hub release failures (real emitCrawlToHub)", () => {
  it("partial failure (second post fails): the one already posted is recorded in the wolf's dedup, no run-level emitted.json, and the retry sends only the rest", async () => {
    const f = fixture(3);
    finish(f);
    const den = join(tmp("den"), "kb");
    mkdirSync(den, { recursive: true });
    writeFileSync(join(den, "emitted.json"), '{"older":"sha256:1"}');
    let call = 0;
    const stored = new Set<string>();
    const flaky = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { denTopicId: string };
      if (++call === 2) return Response.json({ message: "try later Bearer tok-secret" }, { status: 409 });
      const dup = stored.has(b.denTopicId);
      stored.add(b.denTopicId);
      return Response.json({ id: `${b.denTopicId}.md`, wolf: "w", duplicate: dup }, { status: dup ? 200 : 201 });
    }) as unknown as typeof fetch;
    const hub = { baseUrl: "https://hub.example", token: "tok-secret", fetch: flaky };
    const svc = svcOf(f, { runner: { run: holdRunner().runner.run, emit: (d, o) => emitCrawlToHub(d, hub, o as never) }, env: { WOLFPACK_HUB_URL: "https://hub.example", WOLFPACK_HUB_TOKEN: "tok-secret" } });
    const err = (await svc.release(f.runDir, { wolf: "w", confirmed: true, roots: { denLocal: den } }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/409/);
    expect(err.message).not.toContain("tok-secret");
    expect(Object.keys(JSON.parse(readFileSync(join(den, "emitted.json"), "utf-8"))).length).toBe(1 + 1); // older + the one the hub took before the abort
    expect(existsSync(join(f.runDir, "emitted.json"))).toBe(false); // the run is not "released"
    const ok = await svc.release(f.runDir, { wolf: "w", confirmed: true, roots: { denLocal: den } });
    expect(ok.emitted).toBe(2); // only what was not yet recorded
    expect(Object.keys(JSON.parse(readFileSync(join(den, "emitted.json"), "utf-8"))).length).toBe(1 + 3); // older + all three
    expect(existsSync(join(f.runDir, "emitted.json"))).toBe(true);
    expect(stored.size).toBe(3);
  });
});

describe("hub seams, domains", () => {
  const jsonFetch = (routes: Record<string, { status: number; body?: unknown }>) =>
    (async (url: string) => {
      const path = new URL(url).pathname;
      const hit = routes[path];
      return hit ? Response.json(hit.body ?? {}, { status: hit.status }) : Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
  const hubEnv = { WOLFPACK_HUB_URL: "http://hub" };

  it("declared domains come from the hub registry when there is no KB mirror; a local mirror wins", async () => {
    const f = fixture();
    const svc = svcOf(f, { env: hubEnv });
    expect(svc.declaredDomains()).toBeNull();
    vi.stubGlobal("fetch", jsonFetch({ "/v1/registry/domains": { status: 200, body: { domains: [{ name: "wolfpack" }, { name: "snapjack" }] } } }));
    expect([...(await svc.refreshDomains())!].sort()).toEqual(["snapjack", "wolfpack"]);
    expect(svc.declaredDomains()!.has("snapjack")).toBe(true);
    const local = svcOf(f, { env: hubEnv, localDomains: () => new Set(["only-local"]) });
    expect([...(await local.refreshDomains())!]).toEqual(["only-local"]);
  });

  it("an unreachable registry with no mirror fails closed (requireDomains / startRun refuse) instead of skipping the domain check", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", jsonFetch({}));
    const svc = svcOf(f, { env: hubEnv });
    expect(await svc.refreshDomains()).toBeNull();
    expect(() => svc.requireDomains()).toThrowError(/could not be read/);
    await expect(svc.startRun({ planPath: f.planPath })).rejects.toMatchObject({ code: "domains-unknown" });
    // no hub and no mirror at all: nothing to check against (unchanged behaviour)
    expect(() => svcOf(f).requireDomains()).not.toThrow();
  });

  it("the last good hub list is kept when a refresh fails, and a fresh list is cached for the TTL", async () => {
    const f = fixture();
    let t = 0;
    let calls = 0;
    let up = true;
    vi.stubGlobal("fetch", async () => (calls++, up ? Response.json({ domains: [{ name: "wolfpack" }] }) : Response.json({}, { status: 503 })));
    const svc = svcOf(f, { env: hubEnv, now: () => t, domainsTtlMs: 1000 });
    await svc.refreshDomains();
    await svc.refreshDomains();
    expect(calls).toBe(1); // cached
    t += 2000;
    up = false;
    expect([...(await svc.refreshDomains())!]).toEqual(["wolfpack"]); // hub down: last good, not null
    expect(calls).toBe(2);
    expect(() => svc.requireDomains()).not.toThrow();
  });

  it("the receipts / check seams feature-detect: a hub without the routes yields undefined; with them the ids come back", async () => {
    const { readHubReceipts, checkHubContributions } = await import("./hub.js");
    const none = { baseUrl: "http://hub", fetch: jsonFetch({}) };
    expect(await readHubReceipts(none)).toBeUndefined();
    expect(await checkHubContributions(none, [{ denTopicId: "t" }])).toBeUndefined();
    const some = { baseUrl: "http://hub", fetch: jsonFetch({ "/v1/contributions/receipts": { status: 200, body: { curated: ["crawl-wolfpack-docs"] } } }) };
    expect([...(await readHubReceipts(some))!]).toEqual(["crawl-wolfpack-docs"]);
  });

  it("preview with an unreachable hub reports hubState unknown (and ok when the hub answers); the registry being down does not block the preview", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "history.json"), "{}");
    const items = [{ kind: "topic", topic: "docs0", denTopicId: "crawl-wolfpack-docs0", title: "T", summary: "s", bodyChars: 5, currency: "current", status: "emit" }];
    const runner = emitStub({ emit: () => ({ emitted: 0, skipped: 0, dest: "x", dir: f.runDir, contributions: items, delta: [] }) as never });
    const svc = svcOf(f, { runner, env: hubEnv });
    vi.stubGlobal("fetch", jsonFetch({}));
    expect(await svc.previewRelease(f.runDir, { wolf: "w" })).toMatchObject({ hubState: "unknown", toEmit: 1 });
    vi.stubGlobal("fetch", jsonFetch({ "/v1/contributions/receipts": { status: 200, body: { curated: ["crawl-wolfpack-docs0"] } } }));
    const pv = await svc.previewRelease(f.runDir, { wolf: "w" });
    expect(pv.hubState).toBe("ok");
    expect(pv.curated.has("crawl-wolfpack-docs0")).toBe(true);
    // no hub target: the field is ok (nothing to be unknown about)
    expect((await svcOf(f, { runner, env: { KB_OPS: tmp("ops") } }).previewRelease(f.runDir, { wolf: "w" })).hubState).toBe("ok");
  });
});

describe("review round 2: reservation, cancel marker, resume vs release, domains, live redaction", () => {
  it("a reservation survives a slow runner.run (no sink yet) because the heartbeat refreshes it", async () => {
    const f = fixture();
    let t = 1_000_000;
    const owner = svcOf(f, { runner: holdRunner({ sink: false }).runner, pid: 111, now: () => t, staleMs: 45_000, isAlive: () => true });
    await owner.startRun({ planPath: f.planPath });
    const peer = svcOf(f, { pid: 222, now: () => t, staleMs: 45_000, isAlive: () => true });
    t += 30_000;
    owner.heartbeat();
    t += 30_000; // 60 s since the reservation was made, 30 s since its last refresh
    await expect(peer.startRun({ planPath: f.planPath })).rejects.toMatchObject({ code: "clash" });
    owner.shutdown();
  });

  it("stop --force on a live foreign run leaves a cancel marker; the owner aborts at its next heartbeat", async () => {
    const f = fixture();
    const owner = svcOf(f, { pid: 111, isAlive: () => true });
    const dir = (await owner.startRun({ planPath: f.planPath })).runDir;
    const peer = svcOf(f, { pid: 222, isAlive: () => true });
    expect(peer.stopRun(dir)).toMatchObject({ error: "foreign" });
    expect(peer.stopRun(dir, { force: true })).toEqual({ stopped: dir, requested: true });
    owner.heartbeat();
    await new Promise((r) => setTimeout(r, 20));
    expect(owner.listRuns().find((r) => r.runDir === dir)!.state).toBe("cancelled");
    expect(existsSync(join(dir, CANCEL_MARKER))).toBe(false);
    owner.shutdown();
  });

  it("a resume is refused while the dir is being released (in-process or a fresh release.lock from another process)", async () => {
    const f = fixture();
    const owner = svcOf(f, { pid: 111 });
    const dir = (await owner.startRun({ planPath: f.planPath })).runDir;
    writeFileSync(join(dir, "observations.jsonl"), "");
    const second = svcOf(f, { pid: 222, isAlive: () => false });
    const out = second.outstanding(f.plan);
    expect(out.map((o) => o.runDir)).toEqual([dir]);
    const lock = acquireLock(join(dir, "release.lock"), 60_000, { pid: 7, host: "h1", boot: "b1", isAlive: () => true, now: () => Date.now() });
    expect(lock).toBeTruthy();
    const third = svcOf(f, { pid: 333, isAlive: (p) => p === 7 });
    await expect(third.startRun({ planPath: f.planPath, resume: out[0] })).rejects.toMatchObject({ code: "releasing" });
  });

  it("a KB_OPS-only host (release target, no readable domains, no hub) fails closed; no release target at all skips the check", async () => {
    const f = fixture();
    const ops = svcOf(f, { env: { KB_OPS: tmp("ops") } });
    await expect(ops.startRun({ planPath: f.planPath })).rejects.toMatchObject({ code: "domains-unknown" });
    expect(() => ops.requireDomains()).toThrowError(/declared domains could not be read/);
    const none = svcOf(f, { env: {} });
    expect(() => none.requireDomains()).not.toThrow();
  });

  it("a down registry is not re-tried on every call (negative cache) and a last-good list expires after domainsMaxAgeMs", async () => {
    const f = fixture();
    let t = 1_000;
    let calls = 0;
    let up = true;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return up ? Response.json({ domains: [{ name: "wolfpack" }] }) : new Response("no", { status: 503 });
    });
    const svc = svcOf(f, { env: { WOLFPACK_HUB_URL: "https://hub.example", WOLFPACK_HUB_TOKEN: "x" }, now: () => t, domainsTtlMs: 100, domainsRetryMs: 5_000, domainsMaxAgeMs: 60_000 });
    expect([...(await svc.refreshDomains())!]).toEqual(["wolfpack"]);
    up = false;
    t += 200;
    expect(await svc.refreshDomains()).toBeTruthy(); // failed read, last good kept
    const n = calls;
    t += 200;
    await svc.refreshDomains();
    expect(calls).toBe(n); // inside the retry window: no new request
    t += 120_000;
    await svc.refreshDomains();
    expect(svc.declaredDomains()).toBeNull(); // too old to trust
  });

  it("the live status scrubs a token in a row error, not only the persisted record", async () => {
    const f = fixture();
    const runner: CrawlRunner = {
      run(planFile, o) {
        const dir = join(o.sinkBase!, "run-live");
        mkdirSync(dir, { recursive: true });
        copyFileSync(planFile, join(dir, "plan.yaml"));
        o.onSink?.(dir);
        o.onProgress?.({ phase: "batch", batch: { topic: "docs0", index: 0, total: 1, files: 1, stage: "error", error: "401 Bearer live-secret-9 tok-live-abc" } });
        return new Promise(() => {});
      },
      emit: () => {
        throw new Error("x");
      },
    };
    const svc = svcOf(f, { runner, env: { WOLFPACK_HUB_TOKEN: "tok-live-abc" } });
    const dir = (await svc.startRun({ planPath: f.planPath })).runDir;
    const view = svc.listRuns().find((r) => r.runDir === dir)!;
    expect(JSON.stringify(view.progress)).not.toMatch(/live-secret|tok-live-abc/);
    svc.shutdown();
  });

  it("a run.json from a newer version is `unsupported` (left alone, not corrupt, not releasable)", async () => {
    const f = fixture();
    writeFileSync(join(f.runDir, "run.json"), JSON.stringify({ version: 2, state: "done" }));
    const svc = svcOf(f);
    expect(svc.listRuns().find((r) => r.runDir === f.runDir)!.state).toBe("unsupported");
    expect(existsSync(join(f.runDir, "run.json.corrupt"))).toBe(false);
    expect(svc.releasable(f.runDir)).toMatchObject({ ok: false, code: "unsupported" });
  });
});

describe("review round 3", () => {
  it("release.lock is refreshed during a slow emit and cannot be taken over by a second releaser", async () => {
    const f = fixture();
    finish(f);
    let t = 5_000_000;
    let release!: () => void;
    let started!: () => void;
    const inEmit = new Promise<void>((r) => (started = r));
    const slow: CrawlRunner = {
      run: holdRunner().runner.run,
      emit: () =>
        new Promise((resolve) => {
          started();
          release = () => resolve({ emitted: 1, skipped: 0, dest: "inbox", dir: "", contributions: [], delta: [] } as never);
        }),
    };
    const ops = tmp("ops");
    const mk = (pid: number) => svcOf(f, { runner: slow, env: { KB_OPS: ops }, pid, isAlive: () => true, now: () => t, localDomains: () => new Set(["wolfpack"]), releaseLockMaxAgeMs: 1000, releaseRefreshMs: 10 });
    const a = mk(111);
    const p = a.release(f.runDir, { wolf: "w", confirmed: true });
    await inEmit;
    const lock = join(f.runDir, "release.lock");
    const at0 = JSON.parse(readFileSync(lock, "utf-8")).at;
    t += 900;
    await new Promise((r) => setTimeout(r, 40)); // the interval fires on real time and stamps the fake clock
    expect(JSON.parse(readFileSync(lock, "utf-8")).at).toBeGreaterThan(at0);
    t += 900; // 1800 ms since acquisition, but only 900 since the last refresh (< 1000)
    await expect(mk(222).release(f.runDir, { wolf: "w", confirmed: true })).rejects.toMatchObject({ code: "releasing" });
    release();
    await p;
    expect(existsSync(lock)).toBe(false);
  });

  it("resume of a newer-version run.json throws the `unsupported` code", async () => {
    const f = fixture();
    const owner = svcOf(f, { pid: 111 });
    const dir = (await owner.startRun({ planPath: f.planPath })).runDir;
    writeFileSync(join(dir, "observations.jsonl"), "");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ version: 2, state: "cancelled" }));
    const svc = svcOf(f, { pid: 222 });
    await expect(svc.startRun({ planPath: f.planPath, resume: { runDir: dir } as never })).rejects.toMatchObject({ code: "unsupported" });
  });
});
