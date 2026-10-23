import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyze, formatDoctor, workDoctor, type WorkItemLite } from "./work-doctor.js";

const NOW = new Date("2026-10-23T12:00:00Z");
let n = 0;
const item = (o: Partial<WorkItemLite>): WorkItemLite => ({
  id: `work-wolfpack-i${++n}`, kind: "task", domain: "wolfpack", title: `t${n}`, stage: "plan",
  successCriteria: "done", partOf: null, graduated: null, updated: "2026-10-22", ...o,
});

describe("analyze", () => {
  it("flags parents behind or ahead of their children and idle in_build items", () => {
    const behind = item({ kind: "feature", stage: "plan" });
    const done = item({ kind: "feature", stage: "in_build", updated: "2026-10-22" });
    const ahead = item({ kind: "feature", stage: "shipped" });
    const idle = item({ kind: "task", stage: "in_build", updated: "2026-10-10", partOf: "x" });
    const items = [
      behind, item({ stage: "in_build", partOf: behind.id }),
      done, item({ stage: "shipped", partOf: done.id }), item({ stage: "archived", partOf: done.id }),
      ahead, item({ stage: "plan", partOf: ahead.id }),
      idle,
    ];
    const r = analyze(items, { now: NOW });
    const ids = r.staleStages.map((f) => f.id);
    expect(ids).toEqual([behind.id, done.id, ahead.id, idle.id]);
    expect(r.staleStages[3]!.detail).toContain("idle 13 days");
  });

  it("ignores archived children, containers, standing initiatives and fresh in_build items", () => {
    const inbox = item({ kind: "feature", stage: "plan", container: true, successCriteria: null });
    const std = item({ kind: "initiative", stage: "in_build", standing: true });
    const fresh = item({ kind: "task", stage: "in_build", updated: "2026-10-21" });
    const items = [inbox, item({ stage: "shipped", partOf: inbox.id }), std, item({ stage: "shipped", partOf: std.id }), fresh];
    expect(analyze(items, { now: NOW }).staleStages).toEqual([]);
  });

  it("finds shipped-not-graduated features and lone shipped Inbox tasks", () => {
    const inbox = item({ kind: "feature", container: true });
    const feat = item({ kind: "feature", stage: "shipped" });
    const gradFeat = item({ kind: "feature", stage: "shipped", graduated: "2026-10-20" });
    const lone = item({ stage: "shipped", partOf: inbox.id });
    const inFeat = item({ stage: "shipped", partOf: feat.id });
    const r = analyze([inbox, feat, gradFeat, lone, inFeat], { now: NOW });
    expect(r.shippedNotGraduated.map((f) => f.id)).toEqual([feat.id, lone.id]);
  });

  it("reports live features/initiatives without criteria (not Inbox, not archived, not tasks)", () => {
    const a = item({ kind: "feature", successCriteria: null });
    const b = item({ kind: "initiative", successCriteria: "  " });
    const skip = [
      item({ kind: "feature", successCriteria: null, container: true }),
      item({ kind: "feature", successCriteria: null, stage: "archived" }),
      item({ kind: "task", successCriteria: null }),
    ];
    expect(analyze([a, b, ...skip], { now: NOW }).missingCriteria.map((f) => f.id)).toEqual([a.id, b.id]);
  });

  it("reports live items under archived parents and counts domain × kind × stage", () => {
    const p = item({ kind: "feature", stage: "archived" });
    const live = item({ stage: "plan", partOf: p.id });
    const dead = item({ stage: "archived", partOf: p.id });
    const personal = item({ domain: "personal", kind: "task", stage: "shipped" });
    const r = analyze([p, live, dead, personal], { now: NOW });
    expect(r.underArchived.map((f) => f.id)).toEqual([live.id]);
    expect(r.counts.wolfpack!.task).toEqual({ plan: 1, archived: 1 });
    expect(r.counts.personal!.task).toEqual({ shipped: 1 });
    expect(r.total).toBe(4);
  });

  it("formats a numbered list across groups", () => {
    const f = item({ kind: "feature", successCriteria: null });
    const text = formatDoctor(analyze([f], { now: NOW }));
    expect(text).toContain("Live features/initiatives without success criteria (1)");
    expect(text).toContain("1. ");
    expect(text).toContain("wolfpack feature: plan 1");
  });
});

describe("workDoctor against a fake Work API", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); vi.restoreAllMocks(); });

  it("only issues GETs, sends the key, passes the domain filter and prints JSON", async () => {
    const seen: { method?: string; url?: string; key?: string | string[] }[] = [];
    const items = [item({ kind: "feature", successCriteria: null })];
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const report = await workDoctor({ endpoint: `http://127.0.0.1:${port}`, token: "k", domain: "wolfpack", json: true, now: NOW });
    expect(seen).toEqual([{ method: "GET", url: "/work?domain=wolfpack", key: "k" }]);
    expect(report.missingCriteria).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])).total).toBe(1);
  });

  it("fails clearly when the Work API is not configured", async () => {
    await expect(workDoctor({ endpoint: "", token: "" })).rejects.toThrow(/WORK_ENDPOINT/);
  });
});
