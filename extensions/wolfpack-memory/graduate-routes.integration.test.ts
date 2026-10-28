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
const behave = { workRecordFails: false, distillCalls: 0, recordCalls: 0, featureId: "" };

const engine = (): Engine =>
  ({
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "distill") {
        behave.distillCalls++;
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

beforeEach(() => {
  behave.workRecordFails = false;
  behave.distillCalls = 0;
  behave.recordCalls = 0;
});

describe("graduate routes", () => {
  it("preview returns the entries and a token and changes nothing", async () => {
    tw = await boot(await devRoot());
    const { feature, tasks } = await makeFeature(tw);
    const p = await tw.client.previewGraduation!("testwolf", feature);
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

    const p = await tw.client.previewGraduation!("testwolf", feature);
    const r = await tw.client.confirmGraduation!("testwolf", feature, p.token);
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
    await expect(tw.client.confirmGraduation!("testwolf", feature, p.token)).rejects.toMatchObject({ code: "preview_stale" });
  });

  it("refuses a wrong or expired token and changes nothing", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const a = await makeFeature(tw);
    const pa = await tw.client.previewGraduation!("testwolf", a.feature);
    const b = await makeFeature(tw);
    await expect(tw.client.confirmGraduation!("testwolf", b.feature, pa.token)).rejects.toMatchObject({ code: "preview_stale", message: expect.stringContaining(`for ${a.feature}`) });
    await expect(tw.client.confirmGraduation!("testwolf", a.feature, "deadbeef0000")).rejects.toMatchObject({ code: "preview_stale" });
    const file = join(den, "tasks", "graduation", `${pa.token}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, createdAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
    await expect(tw.client.confirmGraduation!("testwolf", a.feature, pa.token)).rejects.toMatchObject({ code: "preview_stale", message: expect.stringContaining("too old") });
    expect(inbox(tw)).toEqual([]);
    expect((await item(tw, a.feature)).graduated).toBeFalsy();
  });

  it("refuses a feature that is not ready, with the reason (409 not_ready)", async () => {
    tw = await boot(await devRoot());
    const { feature } = await makeFeature(tw, { open: 2 });
    await expect(tw.client.previewGraduation!("testwolf", feature)).rejects.toMatchObject({ code: "not_ready", message: expect.stringContaining("2 tasks open") });
    const res = await fetch(`${tw.url}/v1/wolves/testwolf/work/${feature}/graduate/preview`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(behave.distillCalls).toBe(0);
  });

  it("a drain failure at preview or at confirm leaves nothing archived", async () => {
    tw = await boot(await devRoot());
    const den = tw.wolf.config.den;
    const { feature, tasks } = await makeFeature(tw);
    tag(den, tasks[0]!);
    behave.workRecordFails = true;
    await expect(tw.client.previewGraduation!("testwolf", feature)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("nothing archived") });
    expect(poolCount(den)).toBe(1);

    behave.workRecordFails = false;
    const p = await tw.client.previewGraduation!("testwolf", feature);
    expect(p.foldedObservations).toBe(1);
    expect(poolCount(den)).toBe(0);
    tag(den, tasks[1]!, "a late observation");
    behave.workRecordFails = true;
    await expect(tw.client.confirmGraduation!("testwolf", feature, p.token)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("nothing archived") });
    expect(inbox(tw)).toEqual([]);
    expect((await item(tw, feature)).graduated).toBeFalsy();
    for (const id of [feature, ...tasks]) expect((await item(tw, id)).stage).not.toBe("archived");
    // the preview survives a failed confirm: trying again once the model is back works and includes the late fold
    behave.workRecordFails = false;
    const r = await tw.client.confirmGraduation!("testwolf", feature, p.token);
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
    const p = await tw.client.previewGraduation!("testwolf", feature);
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
  });
});
