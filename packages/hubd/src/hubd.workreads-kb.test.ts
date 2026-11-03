/** Hub work reads build state from the KB copy's work/*.md, with the hub's own ledger applied on top (work-wolfpack-MMeb8jJ). */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { listWorkItems, loadMergedWorkState, readWorkRecordFor } from "./work-reads.js";
import { OP, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const F = "work-wolfpack-AAAAAAA";
const T1 = "work-wolfpack-BBBBBBB";
const T2 = "work-wolfpack-CCCCCCC";
const P = "work-personal-DDDDDDD";

function md(id: string, domain: string, o: { kind?: string; title?: string; stage?: string; partOf?: string; body?: string; extra?: string[]; log?: string[] } = {}): string {
  return [
    "---", `id: ${id}`, "nodeType: work", `kind: ${o.kind ?? "task"}`, `domain: ${domain}`, `title: "${o.title ?? id}"`, `stage: ${o.stage ?? "plan"}`, "assignee: owner",
    'successCriteria: "ok"', ...(o.partOf ? [`partOf: ${o.partOf}`] : []), ...(o.extra ?? []), "created: 2026-01-02", "updated: 2026-01-03", "---", "", `# ${o.title ?? id}`, "", o.body ?? "KB body text", "", ...(o.log ? ["## Log", "", ...o.log, ""] : []),
  ].join("\n");
}
function put(roots: KbRoots, domain: string, id: string, text: string): void {
  mkdirSync(workDir(roots, domain), { recursive: true });
  writeFileSync(join(workDir(roots, domain), `${id}.md`), text);
}
function ledger(roots: KbRoots, ...events: object[]): void {
  mkdirSync(dirname(workLedgerFile(roots)), { recursive: true });
  appendFileSync(workLedgerFile(roots), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function rig(): KbRoots {
  const dir = mkdtempSync(join(tmpdir(), "hubd-wreads-"));
  tmp.push(dir);
  const roots = hubRoots(dir);
  put(roots, "wolfpack", F, md(F, "wolfpack", { kind: "feature", title: "Feat" }));
  put(roots, "wolfpack", T1, md(T1, "wolfpack", { partOf: F, title: "One", body: "Hello from the KB" }));
  put(roots, "wolfpack", T2, md(T2, "wolfpack", { partOf: F, title: "Two" }));
  put(roots, "personal", P, md(P, "personal", { title: "Mine" }));
  return roots;
}
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();

describe("hub work reads from the KB copy", () => {
  it("lists KB-only items, filtered by domain", () => {
    const roots = rig();
    expect(ids(listWorkItems(roots, "wolfpack", false))).toEqual([F, T1, T2].sort());
    expect(ids(listWorkItems(roots, "personal", false))).toEqual([P]);
    expect(ids(listWorkItems(roots, "snapjack", false))).toEqual([]);
  });

  it("a ledger event overrides the KB stage; other items keep the file's", () => {
    const roots = rig();
    ledger(roots, { type: "work.staged", id: T1, at: "2026-02-01 10:00", to: "shipped" });
    const rec = readWorkRecordFor(roots, T1)!;
    expect(rec.stage).toBe("shipped");
    expect(readWorkRecordFor(roots, T2)!.stage).toBe("plan");
  });

  it("a ledger deletion hides a KB item; a ledger-only item is added", () => {
    const roots = rig();
    ledger(
      roots,
      { type: "work.deleted", id: T2, at: "2026-02-01 10:00" },
      { type: "work.created", id: "work-wolfpack-EEEEEEE", at: "2026-02-01 10:00", kind: "task", domain: "wolfpack", title: "Ledger only", assignee: "owner" },
    );
    const got = ids(listWorkItems(roots, "wolfpack", false));
    expect(got).not.toContain(T2);
    expect(got).toContain("work-wolfpack-EEEEEEE");
    expect(readWorkRecordFor(roots, T2)).toBeUndefined();
  });

  it("the record carries the KB body and the feature's children", () => {
    const roots = rig();
    expect(readWorkRecordFor(roots, T1)!.plan).toContain("Hello from the KB");
    const feat = readWorkRecordFor(roots, F)!;
    expect(JSON.stringify(feat)).toContain(T1);
    expect(readWorkRecordFor(roots, "work-wolfpack-ZZZZZZZ")).toBeUndefined();
  });

  it("picks up a changed file (cache invalidates)", () => {
    const roots = rig();
    expect(readWorkRecordFor(roots, T1)!.title).toBe("One");
    put(roots, "wolfpack", T1, md(T1, "wolfpack", { partOf: F, title: "One renamed with longer text" }));
    expect(readWorkRecordFor(roots, T1)!.title).toBe("One renamed with longer text");
  });

  it("GET /v1/work and /v1/work/:id/record serve KB items over HTTP (domain-filtered)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hubd-wreads-http-"));
    tmp.push(dataDir);
    seedTokens(dataDir, []);
    const roots = hubRoots(dataDir);
    put(roots, "wolfpack", T1, md(T1, "wolfpack", { body: "Hello from the KB" }));
    put(roots, "personal", P, md(P, "personal"));
    const hub = await createHubServer({ dataDir });
    servers.push(hub);
    const list = (d: string) => fetch(`${hub.url}/v1/work?domain=${d}`, { headers: OP }).then((r) => r.json() as Promise<{ items: { id: string }[] }>);
    expect(ids(await list("wolfpack"))).toEqual([T1]);
    expect(ids(await list("personal"))).toEqual([P]);
    const rec = await fetch(`${hub.url}/v1/work/${T1}/record`, { headers: OP });
    expect(rec.status).toBe(200);
    expect(((await rec.json()) as { plan: string }).plan).toContain("Hello from the KB");
  });
});

const at = "2026-03-01 10:00";
const T3 = "work-wolfpack-FFFFFFF";

describe("hub work reads: precedence, caching, errors", () => {
  it("a deleted file disappears and a new file appears", () => {
    const roots = rig();
    expect(ids(listWorkItems(roots, "wolfpack", false))).toContain(T2);
    unlinkSync(join(workDir(roots, "wolfpack"), `${T2}.md`));
    put(roots, "wolfpack", T3, md(T3, "wolfpack"));
    const got = ids(listWorkItems(roots, "wolfpack", false));
    expect(got).not.toContain(T2);
    expect(got).toContain(T3);
  });

  it("a same-size edit with a new mtime is picked up", () => {
    const roots = rig();
    expect(readWorkRecordFor(roots, T1)!.title).toBe("One");
    const path = join(workDir(roots, "wolfpack"), `${T1}.md`);
    writeFileSync(path, md(T1, "wolfpack", { partOf: F, title: "Uno", body: "Hello from the KB" }));
    const t = new Date(Date.now() + 5000);
    utimesSync(path, t, t);
    expect(readWorkRecordFor(roots, T1)!.title).toBe("Uno");
  });

  it("two ledger appends close together are both seen", () => {
    const roots = rig();
    ledger(roots, { type: "work.staged", id: T1, at, to: "approved" });
    expect(readWorkRecordFor(roots, T1)!.stage).toBe("approved");
    ledger(roots, { type: "work.staged", id: T1, at, to: "in_build" });
    expect(readWorkRecordFor(roots, T1)!.stage).toBe("in_build");
  });

  it("a malformed file is skipped and the list still returns", () => {
    const roots = rig();
    put(roots, "wolfpack", "work-wolfpack-GGGGGGG", "no frontmatter at all");
    put(roots, "wolfpack", "work-wolfpack-HHHHHHH", md("work-wolfpack-HHHHHHH", "wolfpack", { kind: "bogus" }));
    expect(ids(listWorkItems(roots, "wolfpack", false))).toEqual([F, T1, T2].sort());
  });

  it("rejects a hostile domain with 400 and an unknown domain lists empty", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hubd-wreads-dom-"));
    tmp.push(dataDir);
    seedTokens(dataDir, []);
    const hub = await createHubServer({ dataDir });
    servers.push(hub);
    for (const d of ["../..", "a/b", "Wolfpack", "-x", "a..b"]) expect((await fetch(`${hub.url}/v1/work?domain=${encodeURIComponent(d)}`, { headers: OP })).status).toBe(400);
    expect(() => listWorkItems(hubRoots(dataDir), "../..", false)).toThrow();
    const none = await fetch(`${hub.url}/v1/work?domain=nothing`, { headers: OP });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ items: [] });
  });

  it("graduated filtering holds for a file-graduated and a ledger-graduated item", () => {
    const roots = rig();
    put(roots, "wolfpack", T3, md(T3, "wolfpack", { stage: "archived", extra: ["graduated: 2026-02-02"] }));
    ledger(roots, { type: "work.graduated", id: T2, at });
    const shown = ids(listWorkItems(roots, "wolfpack", false));
    expect(shown).not.toContain(T3);
    expect(shown).not.toContain(T2);
    expect(shown).toContain(T1);
    const all = ids(listWorkItems(roots, "wolfpack", true));
    expect(all).toContain(T3);
    expect(all).toContain(T2);
  });

  it("on a touched item, unlink / unschedule / standing=false win over the file", () => {
    const roots = rig();
    put(roots, "wolfpack", T3, md(T3, "wolfpack", { extra: [`dependsOn:\n  - ${T1}\n  - ${T2}`, 'scheduledFor: "2026-04-01 09:00"', "durationMinutes: 30", "standing: true"] }));
    const before = readWorkRecordFor(roots, T3)!;
    expect(before.dependsOn).toEqual([T1, T2]);
    ledger(
      roots,
      { type: "work.unlinked", id: T3, at, rel: "depends_on", target: T1 },
      { type: "work.scheduled", id: T3, at, scheduledFor: null, durationMinutes: null },
      { type: "work.standing", id: T3, at, standing: false },
    );
    const st = loadMergedWorkState(roots, "wolfpack").get(T3)!;
    expect(st.dependsOn).toEqual([T2]);
    expect(st.scheduledFor).toBeNull();
    expect(st.standing).toBe(false);
  });

  it("an untouched file item keeps links, schedule and standing", () => {
    const roots = rig();
    put(roots, "wolfpack", T3, md(T3, "wolfpack", { extra: [`dependsOn:\n  - ${T1}`, 'scheduledFor: "2026-04-01 09:00"', "standing: true"] }));
    const st = loadMergedWorkState(roots, "wolfpack").get(T3)!;
    expect(st).toMatchObject({ dependsOn: [T1], scheduledFor: "2026-04-01 09:00", standing: true });
  });

  it("a ledger work.created for an id that also has a file replaces the file's item", () => {
    const roots = rig();
    ledger(roots, { type: "work.created", id: T1, at, kind: "task", domain: "wolfpack", title: "From ledger", assignee: "owner" });
    expect(readWorkRecordFor(roots, T1)!.title).toBe("From ledger");
    expect(ids(listWorkItems(roots, "wolfpack", false)).filter((i) => i === T1)).toHaveLength(1);
  });

  it("the record's log tail comes from the file's ## Log section", () => {
    const roots = rig();
    put(roots, "wolfpack", T3, md(T3, "wolfpack", { log: ["- **2026-01-05 10:00** — Built it", "- **2026-01-06 11:00** — Shipped it"] }));
    const rec = readWorkRecordFor(roots, T3)!;
    expect(rec.log).toEqual(["**2026-01-05 10:00** — Built it", "**2026-01-06 11:00** — Shipped it"]);
    expect(rec.plan).not.toContain("Built it");
  });
});

describe("hub writes to an item that exists only in the KB copy", () => {
  it("gives a clear not-found error and writes nothing (writes still fold the hub ledger only)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hubd-wreads-w-"));
    tmp.push(dataDir);
    seedTokens(dataDir, []);
    put(hubRoots(dataDir), "wolfpack", T1, md(T1, "wolfpack"));
    const hub = await createHubServer({ dataDir });
    servers.push(hub);
    const r = await fetch(`${hub.url}/v1/work/${T1}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...OP }, body: JSON.stringify({ stage: "shipped" }) });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).toContain(T1);
  });
});
