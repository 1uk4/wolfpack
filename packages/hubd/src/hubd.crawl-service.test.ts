/** A crawl released through the crawl service against a real hubd: hub-first target, the contribution lands in the hub's lane, run.json records it, a retry is idempotent. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCrawlService, planCrawl, readPlan, readRunRecord, defaultEmit, runCrawl } from "@wolfpack/memory";
import { createHubServer, type HubServer } from "./server.js";
import { wolfCast } from "./testing/tokens.js";
import { contributionsDir } from "./layout.js";

const dataDir = mkdtempSync(join(tmpdir(), "hubd-crawlsvc-"));
const extra: string[] = [];
const tmp = (p: string) => (extra.push(mkdtempSync(join(tmpdir(), `hubd-crawlsvc-${p}-`))), extra[extra.length - 1]);
let hub: HubServer;
let token = "";
beforeAll(async () => {
  hub = await createHubServer({ dataDir });
  const cast = await wolfCast(hub, ["crawler"]);
  token = cast.wolves.crawler.Authorization.replace(/^Bearer /, "");
});
afterAll(async () => {
  await hub.close();
  for (const d of [dataDir, ...extra]) rmSync(d, { recursive: true, force: true });
});

describe("crawl service release against a real hubd", () => {
  it("releases to the hub when WOLFPACK_HUB_URL is set; a second release re-sends nothing new; no inbox is written", async () => {
    const src = tmp("src");
    writeFileSync(join(src, "a.md"), "# A\nalpha\n");
    const crawlHome = tmp("home");
    const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: crawlHome });
    const plan = readPlan(join(sink.dir, "plan.yaml"));
    const runDir = sink.dir;
    writeFileSync(join(runDir, "topics.json"), JSON.stringify([[plan.batches[0].topic, { title: "T", summary: "s", body: "body text", events: [] }]]));
    writeFileSync(join(runDir, "history.json"), JSON.stringify({ title: "H", summary: "s", body: "history body", events: [] }));

    const env = { WOLFPACK_HUB_URL: hub.url, WOLFPACK_HUB_TOKEN: token };
    const svc = createCrawlService({ crawlHome, env, runner: { run: runCrawl as never, emit: defaultEmit(env) } });
    expect(svc.releaseTarget().kind).toBe("hub");
    const roots = { denLocal: join(tmp("den"), "kb") };

    const pv = await svc.previewRelease(runDir, { wolf: "crawler", roots });
    expect(pv.target.kind).toBe("hub");
    expect(pv.toEmit).toBeGreaterThan(0);
    expect(existsSync(contributionsDir(dataDir, "crawler"))).toBe(false); // a preview posts nothing
    // the hub answers the check route: nothing is held yet, so nothing is unchanged (an answer, not "unknown")
    expect(pv.hubUnchanged).toEqual(new Set());
    expect(pv.hubState).toBe("ok");

    const r = await svc.release(runDir, { wolf: "crawler", roots, confirmed: true });
    expect(r.via).toBe("hub");
    expect(r.dest).toBe(`${hub.url}/v1/contributions`);
    const landed = readdirSync(contributionsDir(dataDir, "crawler")).filter((f) => f.endsWith(".md"));
    expect(landed).toHaveLength(r.emitted);
    expect(readFileSync(join(contributionsDir(dataDir, "crawler"), landed[0]), "utf-8")).toContain("from: crawler");
    expect(readRunRecord(runDir)).toBeUndefined(); // released without a run in this process: no record to amend
    expect(JSON.parse(readFileSync(join(runDir, "emitted.json"), "utf-8"))).toMatchObject({ via: "hub", emitted: r.emitted });

    const again = await svc.release(runDir, { wolf: "crawler", roots, confirmed: true });
    expect(again.emitted).toBe(0);
    expect(readdirSync(contributionsDir(dataDir, "crawler")).filter((f) => f.endsWith(".md"))).toHaveLength(landed.length);
  });

  it("a wrong token fails the release loudly and leaves nothing marked as sent", async () => {
    const src = tmp("src2");
    writeFileSync(join(src, "b.md"), "# B\nbeta\n");
    const crawlHome = tmp("home2");
    const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: crawlHome });
    const plan = readPlan(join(sink.dir, "plan.yaml"));
    writeFileSync(join(sink.dir, "topics.json"), JSON.stringify([[plan.batches[0].topic, { title: "T", summary: "s", body: "body", events: [] }]]));
    writeFileSync(join(sink.dir, "history.json"), JSON.stringify({ title: "H", summary: "s", body: "h", events: [] }));
    const env = { WOLFPACK_HUB_URL: hub.url, WOLFPACK_HUB_TOKEN: "not-a-token" };
    const svc = createCrawlService({ crawlHome, env, runner: { run: runCrawl as never, emit: defaultEmit(env) } });
    const err = await svc.release(sink.dir, { wolf: "crawler", confirmed: true, roots: { denLocal: join(tmp("den2"), "kb") } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("not-a-token");
    expect(() => readFileSync(join(sink.dir, "emitted.json"))).toThrow();
  });
});
