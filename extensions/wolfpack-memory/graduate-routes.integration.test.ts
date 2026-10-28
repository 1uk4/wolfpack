/**
 * The graduate routes on a real sandboxed durable wolf (startTestWolf: scripted model, the sandbox's LOCAL fake Work
 * API and KB roots under a temp dir, a stubbed distill/Record engine). Never touches a live Work API or KB.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { parkExtension, startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import createMemoryExtension from "./unified.js";
import createTasksExtension from "./unified-tasks.js";
import { graduationActionsFor } from "@wolfpack/harness/memory";
import { readBindingFile, writeBindingFile } from "./conversation-binding.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `grad-${p}-`));
let tw: TestWolf | undefined;
beforeEach(() => vi.stubEnv("PI_SUBAGENT_AGENT", ""));
afterEach(async () => {
  vi.unstubAllEnvs();
  await tw?.stop();
  tw = undefined;
});

async function devRoot(): Promise<string> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den") }, devRoot: dev });
  return dev;
}

/** What the scripted engine does for each model step; tests flip these. */
const behave: { workRecordFails: boolean; distillCalls: number; recordCalls: number; featureId: string; hold: Promise<void> | null } = { workRecordFails: false, distillCalls: 0, recordCalls: 0, featureId: "", hold: null };

const engine = (): Engine =>
  ({
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "distill") {
        behave.distillCalls++;
        await behave.hold;
        return schema.parse({
          contributions: [{ slug: "main", title: "How caching works", summary: "Session lookups are cached.", body: `## How\n\nSession lookups are cached for five minutes.\n\n## History\n\n- 2026-10-28: added caching (${behave.featureId})` }],
        });
      }
      if (step === "workRecord") {
        behave.recordCalls++;
        if (behave.workRecordFails) throw new Error("model exploded");
        return schema.parse({ decisions: [], changes: [{ text: "Cached the lookups", from: [] }], findings: [], problems: [] });
      }
      if (step === "classify") return schema.parse({ observations: [] });
      throw new Error(`unexpected step ${step}`);
    },
    usage: { summarize: () => ({}) },
  }) as unknown as Engine;

let opsRoot = "";
function boot(dev: string) {
  const kbBase = tmp("kb");
  return startTestWolf({
    script: [],
    yaml: `sandbox:\n  root: ${dev}\n`,
    hooks: {
      extensions: ({ config, den, env: sandboxEnv }) => {
        // KB_BASE is the live read-only mirror, which a sandbox does not copy: a temp dir stands in.
        const env = { ...sandboxEnv, KB_BASE: kbBase };
        opsRoot = env.KB_OPS!;
        const c = { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env };
        const e = engine();
        const tasks = createTasksExtension({ autoShip: true, engine: () => e }, c);
        const memory = createMemoryExtension({ ...config.memory, engine: e }, c);
        return [parkExtension, adaptToDurable(memory, { wolfDen: den, wolfName: "testwolf" }), adaptToDurable(tasks, { wolfDen: den, wolfName: "testwolf" })];
      },
    },
  });
}

const api = (t: TestWolf) => ({ endpoint: t.wolf.sandbox!.resolved.workEndpoint, token: t.wolf.sandbox!.env.WORK_TOKEN });
async function work(t: TestWolf, method: string, path: string, body?: unknown): Promise<any> {
  const { endpoint, token } = api(t);
  const res = await fetch(`${endpoint}${path}`, { method, headers: { "Content-Type": "application/json", "X-API-Key": token }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
const item = async (t: TestWolf, id: string) => (await work(t, "GET", `/work/${id}`)).item;

/** A feature with `tasks` tasks, each shipped unless `open` says otherwise. */
async function makeFeature(t: TestWolf, opts: { open?: number; tasks?: number } = {}): Promise<{ feature: string; tasks: string[] }> {
  const feature = (await work(t, "POST", "/work", { kind: "feature", domain: "wolfpack", title: "Session caching", assignee: "testwolf", body: "# Session caching\n\n## Plan\n\nCache it.\n" })).id as string;
  const tasks: string[] = [];
  const n = opts.tasks ?? 2;
  for (let i = 0; i < n; i++) {
    const id = (await work(t, "POST", "/work", { kind: "task", domain: "wolfpack", title: `Task ${i}`, assignee: "testwolf", partOf: feature, successCriteria: "it works" })).id as string;
    tasks.push(id);
    if (i >= (opts.open ?? 0)) await work(t, "PATCH", `/work/${id}`, { stage: "shipped" });
  }
  behave.featureId = feature;
  return { feature, tasks };
}

const inbox = (_t: TestWolf): string[] => {
  const dir = join(opsRoot, "inbox", "testwolf");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const pool = (den: string) => join(den, ".memory", "pool", "observations.jsonl");
const tag = (den: string, work: string, content = "we cached the lookups because of the hot path") => {
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  const f = pool(den);
  const row = JSON.stringify({ timestamp: "2026-10-28 10:00", recordedAt: "2026-10-28T10:00:00Z", content, work, feature: work });
  writeFileSync(f, (existsSync(f) ? readFileSync(f, "utf8") : "") + row + "\n");
};
const poolCount = (den: string) => (existsSync(pool(den)) ? readFileSync(pool(den), "utf8").trim().split("\n").filter(Boolean).length : 0);

/** Wait for the item's graduation job to leave `running`. */
async function pollUntil(id: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await tw!.client.graduationStatus!("testwolf", id);
    if (s.state !== "running") return s;
    if (Date.now() > until) throw new Error(`graduation of ${id} still running`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const failed = (s: { code: string; message: string }) => Object.assign(new Error(s.message), { code: s.code });
/** Start a preview job and wait for it: the preview, or a rejection with the job's error code. */
async function preview(id: string) {
  await tw!.client.startGraduationPreview!("testwolf", id);
  const s = await pollUntil(id);
  if (s.state === "error") throw failed(s);
  if (s.state !== "preview_ready") throw new Error(`unexpected status ${s.state}`);
  return s.preview;
}
/** Start a confirm job and wait for it: the result, or a rejection with the job's error code. */
async function confirm(id: string, token: string) {
  await tw!.client.startGraduationConfirm!("testwolf", id, token);
  const s = await pollUntil(id);
  if (s.state === "error") throw failed(s);
  // A confirm that failed leaves the preview valid, so the status offers it again instead of the error.
  if (s.state === "preview_ready") throw Object.assign(new Error("the confirm failed, nothing archived; the preview is still valid"), { code: "engine_error" });
  if (s.state !== "graduated") throw new Error(`unexpected status ${s.state}`);
  return s.result;
}

beforeEach(() => {
  behave.workRecordFails = false;
  behave.distillCalls = 0;
  behave.recordCalls = 0;
  behave.hold = null;
});

describe("graduate routes", () => {
  it("a start answers at once with the running job; a second start returns that job, not a second run", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw);
    let release!: () => void;
    behave.hold = new Promise<void>((r) => (release = r));
    const a = await tw.client.startGraduationPreview!("testwolf", feature);
    const b = await tw.client.startGraduationPreview!("testwolf", feature);
    expect(a).toMatchObject({ kind: "preview", state: "running" });
    expect(b.jobId).toBe(a.jobId);
    expect(await tw.client.graduationStatus!("testwolf", feature)).toMatchObject({ state: "running", jobId: a.jobId });
    release();
    const done = await pollUntil(feature);
    expect(done).toMatchObject({ state: "preview_ready", jobId: a.jobId });
    expect(behave.distillCalls).toBe(1);
  });

  it("status runs none → running → preview_ready → running (confirm) → graduated", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw);
    expect(await tw.client.graduationStatus!("testwolf", feature)).toEqual({ state: "none" });
    const p = await preview(feature);
    const ready = await tw.client.graduationStatus!("testwolf", feature);
    expect(ready).toMatchObject({ state: "preview_ready", preview: { token: p.token } });
    let release!: () => void;
    behave.hold = new Promise<void>((r) => (release = r));
    behave.workRecordFails = false;
    const job = await tw.client.startGraduationConfirm!("testwolf", feature, p.token);
    expect(job.kind).toBe("confirm");
    release();
    const done = await pollUntil(feature);
    expect(done).toMatchObject({ state: "graduated", jobId: job.jobId, result: { graduated: true } });
  });

  it("recovers a finished preview from its token file when wolfd has no job for it (after a restart)", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw);
    // straight through the wolf's graduation actions: the token file exists, wolfd has no job
    const p = await graduationActionsFor(tw.wolf.config.den)!.preview(feature);
    const s = await tw.client.graduationStatus!("testwolf", feature);
    expect(s).toMatchObject({ state: "preview_ready", preview: { token: p.token, itemId: feature } });
    // and the token confirms
    expect(await confirm(feature, p.token)).toMatchObject({ graduated: true });
    // an expired token file is not recovered
    const { feature: f2 } = await makeFeature(tw);
    const p2 = await graduationActionsFor(tw.wolf.config.den)!.preview(f2);
    const file = join(tw.wolf.config.den, "tasks", "graduation", `${p2.token}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), createdAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    expect(await tw.client.graduationStatus!("testwolf", f2)).toEqual({ state: "none" });
  });

  it("a failed job reports its error code in the status, and a new start replaces it", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw, { open: 1 });
    const job = await tw.client.startGraduationPreview!("testwolf", feature);
    const s = await pollUntil(feature);
    expect(s).toMatchObject({ state: "error", jobId: job.jobId, kind: "preview", code: "not_ready", message: expect.stringContaining("1 task open") });
    const again = await tw.client.startGraduationPreview!("testwolf", feature);
    expect(again.jobId).not.toBe(job.jobId);
  });

  it("a feature thread that cannot be closed does not turn a done graduation into an error: graduated, with a warning", async () => {
    tw = await boot(await devRoot());
    const { feature, tasks } = await makeFeature(tw);
    const p = await preview(feature);
    vi.spyOn(tw.wolf.server, "closeFeatureThreads").mockImplementation(() => { throw new Error("thread store locked"); });
    const r = await confirm(feature, p.token);
    expect(r).toMatchObject({ graduated: true, closedThreads: [], warnings: [expect.stringContaining("thread store locked")] });
    for (const id of [feature, ...tasks]) expect((await item(tw, id)).stage).toBe("archived");
  });

  it("a confirm that failed (not stale) falls back to preview_ready from the token file; a stale one stays an error", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    const p = await preview(feature);
    tag(den, tasks[0]!, "a late observation");
    behave.workRecordFails = true;
    await tw.client.startGraduationConfirm!("testwolf", feature, p.token);
    // the job's own state is the error, but the preview is still valid: status offers it again
    const s = await pollUntil(feature);
    expect(s).toMatchObject({ state: "preview_ready", preview: { token: p.token } });
    behave.workRecordFails = false;
    expect(await confirm(feature, p.token)).toMatchObject({ graduated: true });
    // a stale token: the token file is gone, so the error stays
    const { feature: f2 } = await makeFeature(tw);
    await tw.client.startGraduationConfirm!("testwolf", f2, "deadbeef0000");
    expect(await pollUntil(f2)).toMatchObject({ state: "error", code: "preview_stale" });
  });

  it("a start of the other kind while a job runs is refused with 409 busy; the same kind returns the running job", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw);
    let release!: () => void;
    behave.hold = new Promise<void>((r) => (release = r));
    const a = await tw.client.startGraduationPreview!("testwolf", feature);
    const res = await fetch(`${tw.url}/v1/wolves/testwolf/work/${feature}/graduate/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "deadbeef0000" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "busy", message: expect.stringContaining("preview") });
    expect((await tw.client.startGraduationPreview!("testwolf", feature)).jobId).toBe(a.jobId);
    release();
    expect(await pollUntil(feature)).toMatchObject({ state: "preview_ready", jobId: a.jobId });
  });

  it("counts the pending observations a graduation would fold, per task, from this wolf's pool only", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    expect(await tw.client.graduationObservations!("testwolf", feature)).toEqual({ total: 0, byWork: [] });
    tag(den, tasks[0]!);
    tag(den, tasks[0]!, "another");
    tag(den, tasks[1]!);
    tag(den, "work-wolfpack-ZZZZZZZ", "someone else's");
    const c = await tw.client.graduationObservations!("testwolf", feature);
    expect(c.total).toBe(3);
    expect(c.byWork).toEqual([{ id: tasks[0], title: "Task 0", count: 2 }, { id: tasks[1], title: "Task 1", count: 1 }]);
    // counting changes nothing
    expect(poolCount(den)).toBe(4);
  });

  it("preview returns the entries and a token and changes nothing", async () => {
    tw = await boot(await devRoot());
    const { feature, tasks } = await makeFeature(tw);
    const p = await preview(feature);
    expect(p).toMatchObject({ itemId: feature, kind: "feature", title: "Session caching", foldedObservations: 0, readiness: { ready: true } });
    expect(p.token).toMatch(/^[a-f0-9]{12}$/);
    expect(p.contributions).toHaveLength(1);
    expect(p.contributions[0]).toMatchObject({ title: "How caching works", summary: "Session lookups are cached." });
    expect(p.contributions[0]!.body).toContain("cached for five minutes");
    expect(p.archive.map((a) => a.id)).toEqual([feature, ...tasks]);
    expect(inbox(tw)).toEqual([]);
    expect((await item(tw, feature)).graduated).toBeFalsy();
    expect((await item(tw, feature)).stage).not.toBe("archived");
  });

  it("confirm graduates, archives the feature and its tasks, unbinds holders and closes the feature thread", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    const thread = await tw.client.createThread!("testwolf", { kind: "feature", workItemId: feature });
    const cid = Number(JSON.parse(readFileSync(join(den, "wolfd", "threads.json"), "utf8")).threads.find((x: { id: string }) => x.id === thread.id).conversationId);
    // a second conversation bound to one of the tasks
    writeBindingFile(den, 77, { workId: tasks[0]!, domain: "wolfpack", boundAt: "now", featureId: feature });
    expect(readBindingFile(den, cid)).toMatchObject({ workId: feature });

    const p = await preview(feature);
    const r = await confirm(feature, p.token);
    expect(r).toMatchObject({ graduated: true, entries: [p.contributions[0]!.id], lateFolded: 0, unbound: 2 });
    expect(r.archived).toEqual([feature, ...tasks]);
    expect(r.closedThreads).toEqual([thread.id]);
    expect(inbox(tw)).toHaveLength(1);
    expect((await item(tw, feature)).graduated).toBeTruthy();
    for (const id of [feature, ...tasks]) expect((await item(tw, id)).stage).toBe("archived");
    expect(readBindingFile(den, cid)).toBeNull();
    expect(readBindingFile(den, 77)).toBeNull();
    const t = await tw.client.getThread(thread.id);
    expect(t.closed).toBe(true);
    // a token works once
    await expect(confirm(feature, p.token)).rejects.toMatchObject({ code: "preview_stale" });
  });

  it("refuses a wrong or expired token and changes nothing", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const a = await makeFeature(tw);
    const pa = await preview(a.feature);
    const b = await makeFeature(tw);
    await expect(confirm(b.feature, pa.token)).rejects.toMatchObject({ code: "preview_stale", message: expect.stringContaining(`for ${a.feature}`) });
    await expect(confirm(a.feature, "deadbeef0000")).rejects.toMatchObject({ code: "preview_stale" });
    const file = join(den, "tasks", "graduation", `${pa.token}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, createdAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    await expect(confirm(a.feature, pa.token)).rejects.toMatchObject({ code: "preview_stale", message: expect.stringContaining("too old") });
    expect(inbox(tw)).toEqual([]);
    expect((await item(tw, a.feature)).graduated).toBeFalsy();
  });

  it("refuses a feature that is not ready, with the reason (409 not_ready)", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw, { open: 2 });
    await expect(preview(feature)).rejects.toMatchObject({ code: "not_ready", message: expect.stringContaining("2 tasks open") });
    expect(behave.distillCalls).toBe(0);
  });

  it("a drain failure at preview or at confirm leaves nothing archived", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    tag(den, tasks[0]!);
    behave.workRecordFails = true;
    await expect(preview(feature)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("nothing archived") });
    expect(poolCount(den)).toBe(1);

    behave.workRecordFails = false;
    const p = await preview(feature);
    expect(p.foldedObservations).toBe(1);
    expect(poolCount(den)).toBe(0);
    tag(den, tasks[1]!, "a late observation");
    behave.workRecordFails = true;
    await expect(confirm(feature, p.token)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("nothing archived") });
    expect(inbox(tw)).toEqual([]);
    expect((await item(tw, feature)).graduated).toBeFalsy();
    for (const id of [feature, ...tasks]) expect((await item(tw, id)).stage).not.toBe("archived");
    // the preview survives a failed confirm: trying again once the model is back works and includes the late fold
    behave.workRecordFails = false;
    const r = await confirm(feature, p.token);
    expect(r.lateFolded).toBe(1);
    expect(inbox(tw)).toHaveLength(1);
  });

  it("folds pending tagged observations into the Record before distilling", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    tag(den, tasks[0]!);
    tag(den, feature, "feature-level note");
    tag(den, "work-wolfpack-ZZZZZZZ", "someone else's"); // not in scope: stays
    const p = await preview(feature);
    expect(p.foldedObservations).toBe(2);
    expect(poolCount(den)).toBe(1);
    expect(behave.recordCalls).toBeGreaterThan(0);
    expect(behave.distillCalls).toBe(1);
  });

  it("a malformed id or confirm body is invalid_request, an unknown wolf not_found", async () => {
    tw = await boot(await devRoot());
    const post = (path: string, body?: unknown) => fetch(`${tw!.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await post("/v1/wolves/testwolf/work/..%2Fetc/graduate/preview")).status).toBe(400);
    expect((await post("/v1/wolves/testwolf/work/work-wolfpack-AAAAAAA/graduate/confirm", { nope: 1 })).status).toBe(400);
    expect((await post("/v1/wolves/nobody/work/work-wolfpack-AAAAAAA/graduate/preview")).status).toBe(404);
    const get = (path: string) => fetch(`${tw!.url}${path}`);
    expect((await get("/v1/wolves/testwolf/work/..%2Fetc/graduate/status")).status).toBe(400);
    expect((await get("/v1/wolves/testwolf/work/..%2Fetc/graduate/observations")).status).toBe(400);
    expect((await get("/v1/wolves/nobody/work/work-wolfpack-AAAAAAA/graduate/status")).status).toBe(404);
  });
});
