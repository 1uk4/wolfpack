/** Hub work reads build state from the KB copy's work/*.md, with the hub's own ledger applied on top (work-wolfpack-MMeb8jJ). */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workDir, workLedgerFile, type KbRoots } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { listWorkItems, readWorkRecordFor } from "./work-reads.js";
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

function md(id: string, domain: string, o: { kind?: string; title?: string; stage?: string; partOf?: string; body?: string } = {}): string {
  return [
    "---", `id: ${id}`, "nodeType: work", `kind: ${o.kind ?? "task"}`, `domain: ${domain}`, `title: "${o.title ?? id}"`, `stage: ${o.stage ?? "plan"}`, "assignee: owner",
    'successCriteria: "ok"', ...(o.partOf ? [`partOf: ${o.partOf}`] : []), "created: 2026-01-02", "updated: 2026-01-03", "---", "", `# ${o.title ?? id}`, "", o.body ?? "KB body text", "",
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
