/** Hub KB rebuild: preview writes a plan file, apply commits exactly it under the KB lock while hubd keeps answering, restore undoes it. Operator only. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { readLedger } from "@wolfpack/kb/librarian";
import { createHubServer, type HubServer } from "./server.js";
import { OP, seedTokens, workerHeaders } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

let n = 0;
const engine = {
  call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
    if (step === "sectionSummary") return schema.parse({ summary: "about a topic" });
    if (step === "labelSection") return schema.parse({ title: `Topic ${++n} ${["alpha", "beta", "gamma", "delta"][n % 4]}${n}` });
    throw new Error("the split proposal is not available in this test"); // the k-means fallback groups the clusters
  },
  usage: { summarize: () => ({}) },
} as unknown as Engine;
/** Unit vectors: three clusters along axis 1, 2 or 3, read from the entry text. */
let embedderDown = false;
const embedder = {
  embed: async (text: string) => {
    if (embedderDown) throw new Error("embedder unreachable");
    const axis = Number(/axis(\d)/.exec(text)?.[1] ?? 0);
    const jitter = [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7) / 997;
    const v = Array.from({ length: 24 }, (_, d) => (d === 0 ? 3 : 0) + (d === axis ? 1.2 : 0) + (d === 5 + (axis % 3) ? jitter * 0.1 : 0));
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  },
  shouldCompact: () => false,
  compact: () => 0,
} as any;

const ids = Array.from({ length: 27 }, (_, i) => `kb-wp-e${String(i).padStart(2, "0")}`);
const axisOf = (i: number) => 1 + Math.floor(i / 9);

/** A hub with a curator ticking every 20ms and one domain `wp`: 27 entries in 3 clusters, all filed in one old root section. */
async function start() {
  embedderDown = false;
  const dir = mkdtempSync(join(tmpdir(), "hubd-rebuild-"));
  tmp.push(dir);
  seedTokens(dir, ["box"]);
  const eDir = join(dir, "kb", "base", "domains", "wp", "entries");
  mkdirSync(eDir, { recursive: true });
  ids.forEach((id, i) => writeFileSync(join(eDir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\ndomain: wp\nsummary: axis${axisOf(i)} entry ${i}\nsection: sec-wp-root00\n---\n\n# ${id}\n\naxis${axisOf(i)} entry ${i}\n\nbody ${i}\n`));
  mkdirSync(join(dir, "sections"), { recursive: true });
  writeFileSync(join(dir, "sections", "_sections.json"), JSON.stringify([{ id: "sec-wp-root00", domain: "wp", parent: null, depth: 0, label: "root", title: "Root", centroid: [], memberCount: 27, childIds: [], summary: "r", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "x", updated: "x" }]));
  const hub = await createHubServer({ dataDir: dir, port: 0, curator: { enabled: true, pollMs: 20, createEngine: () => engine, getEmbedder: () => embedder } });
  servers.push(hub);
  const post = (path: string, body: unknown, headers: Record<string, string> = OP) => fetch(hub.url + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await post("/v1/registry/domains", { name: "wp" });
  const get = (path: string, headers: Record<string, string> = OP) => fetch(hub.url + path, { headers });
  const revision = async () => ((await (await get("/v1/kb/domains/wp/manifest")).json()) as { revision: number }).revision;
  const sectionOf = (id: string) => /^section: (.+)$/m.exec(readFileSync(join(eDir, `${id}.md`), "utf-8"))![1];
  return { hub, dir, post, get, revision, sectionOf };
}

const FLAGS = { from: "current", applyCrossMoves: false, approvedCrossMoves: [], allowCollapse: false, allowKmeansFallback: true };

async function previewed(s: Awaited<ReturnType<typeof start>>) {
  const r = await s.post("/v1/admin/kb/rebuild/preview", { domain: "wp", flags: FLAGS });
  expect(r.status).toBe(202);
  const { jobId } = (await r.json()) as { jobId: string };
  for (let i = 0; i < 500; i++) {
    const list = (await (await s.get("/v1/admin/kb/rebuild/plans")).json()) as { jobs: Array<{ jobId: string; state: string; planId?: string; error?: string }> };
    const job = list.jobs.find((j) => j.jobId === jobId)!;
    if (job.state === "failed") throw new Error(`preview failed: ${job.error}`);
    if (job.state === "done") return job.planId!;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("preview did not finish");
}

describe("hub KB rebuild", () => {
  it("apply under a live curator keeps the API answering, applies exactly the plan and bumps the revision", async () => {
    const s = await start();
    const planId = await previewed(s);
    const plan = JSON.parse(readFileSync(join(s.dir, "rebuild-plans", `${planId}.json`), "utf-8")) as { assignment: Array<[string, string]>; tree: unknown[] };
    expect(plan.tree.length).toBeGreaterThan(1);
    const before = await s.revision();
    const statuses: number[] = [];
    let stop = false;
    const poller = (async () => { while (!stop) { statuses.push((await s.get("/v1/kb/domains/wp/manifest")).status); await new Promise((r) => setTimeout(r, 2)); } })();
    const r = await s.post("/v1/admin/kb/rebuild/apply", { planId, expectFlags: FLAGS });
    stop = true;
    await poller;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ centroids: "set", centroidsMissing: 0 }); // the preview warmed the embedding cache
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((c) => c === 200)).toBe(true);
    for (const [id, sec] of plan.assignment) expect(s.sectionOf(id)).toBe(sec);
    expect(await s.revision()).toBeGreaterThan(before);
    expect(readLedger(s.hub.roots).filter((e) => e.t === "sections_replaced")).toHaveLength(1);
    // the same plan again is refused only if the entries changed; a stale one after an edit is a 409
    writeFileSync(join(s.dir, "kb", "base", "domains", "wp", "entries", `${ids[0]}.md`), "---\nid: x\ntitle: x\ndomain: wp\nsummary: s\nsection: sec-wp-root00\n---\n\n# x\n\nEDITED\n");
    expect((await s.post("/v1/admin/kb/rebuild/apply", { planId })).status).toBe(409);
  }, 60_000);

  it("a malformed plan file, or one whose domain is not the plan id's, is refused (409/400) before any lock is taken", async () => {
    const s = await start();
    const planId = await previewed(s);
    const good = readFileSync(join(s.dir, "rebuild-plans", `${planId}.json`), "utf-8");
    writeFileSync(join(s.dir, "rebuild-plans", "wp-evil.json"), JSON.stringify({ ...JSON.parse(good), domain: "../x" }));
    writeFileSync(join(s.dir, "rebuild-plans", "other-1.json"), good); // a valid plan of wp under another domain's id
    const before = await s.revision();
    expect((await s.post("/v1/admin/kb/rebuild/apply", { planId: "wp-evil" })).status).toBe(409);
    expect((await s.post("/v1/admin/kb/rebuild/apply", { planId: "other-1" })).status).toBe(400);
    expect(s.sectionOf(ids[0])).toBe("sec-wp-root00");
    expect(await s.revision()).toBe(before);
    expect(existsSync(join(s.dir, "rebuild-backups"))).toBe(false);
  }, 60_000);

  it("apply still succeeds when the embedder is down at apply time, reports centroids missing, and applies exactly the plan", async () => {
    const s = await start();
    const planId = await previewed(s);
    const plan = JSON.parse(readFileSync(join(s.dir, "rebuild-plans", `${planId}.json`), "utf-8")) as { assignment: Array<[string, string]> };
    embedderDown = true;
    const r = await s.post("/v1/admin/kb/rebuild/apply", { planId });
    embedderDown = false;
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ centroids: "missing", centroidsMissing: 27 });
    for (const [id, sec] of plan.assignment) expect(s.sectionOf(id)).toBe(sec);
  }, 60_000);

  it("a worker token is forbidden on every rebuild route", async () => {
    const s = await start();
    const w = workerHeaders("box");
    const codes = [
      (await s.post("/v1/admin/kb/rebuild/preview", { domain: "wp" }, w)).status,
      (await s.post("/v1/admin/kb/rebuild/apply", { planId: "wp-x" }, w)).status,
      (await s.post("/v1/admin/kb/rebuild/restore", { domain: "wp", stamp: "x" }, w)).status,
      (await s.get("/v1/admin/kb/rebuild/plans", w)).status,
    ];
    expect(codes).toEqual([403, 403, 403, 403]);
    expect(readdirSync(s.dir)).not.toContain("rebuild-plans");
  }, 30_000);

  it("restore via the route puts the entries' section lines back", async () => {
    const s = await start();
    const planId = await previewed(s);
    const applied = (await (await s.post("/v1/admin/kb/rebuild/apply", { planId })).json()) as { stamp: string };
    expect(s.sectionOf(ids[0])).not.toBe("sec-wp-root00");
    const r = await s.post("/v1/admin/kb/rebuild/restore", { domain: "wp", stamp: applied.stamp });
    expect(r.status).toBe(200);
    for (const id of ids) expect(s.sectionOf(id)).toBe("sec-wp-root00");
    expect((await s.post("/v1/admin/kb/rebuild/restore", { domain: "wp", stamp: "2020-01-01T00-00-00Z" })).status).toBe(404);
  }, 60_000);
});
