/** The host seams of emitCrawl / runCrawl: explicit roots win over the process env, and nothing lands under the env path. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCrawl } from "./emit.js";
import { loadPublishedDigest } from "./run.js";
import { planCrawl, readPlan } from "./plan.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-seam-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("emitCrawl roots", () => {
  it("a real emit goes to roots.opsRoot/denLocal, never to the env's KB_OPS / WOLF_DEN", () => {
    const envOps = tmp("env-ops");
    const envDen = tmp("env-den");
    vi.stubEnv("KB_OPS", envOps);
    vi.stubEnv("KB_BASE", tmp("env-kb"));
    vi.stubEnv("WOLF_DEN", envDen);
    const src = tmp("src");
    writeFileSync(join(src, "a.md"), "# A\nalpha\n");
    const sink = tmp("sink");
    const { sink: planSink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: sink });
    const runDir = tmp("run");
    const plan = readPlan(join(planSink.dir, "plan.yaml"));
    writeFileSync(join(runDir, "plan.yaml"), readFileSync(join(planSink.dir, "plan.yaml")));
    const topic = plan.batches[0].topic;
    writeFileSync(join(runDir, "topics.json"), JSON.stringify([[topic, { title: "T", summary: "s", body: "body text", events: [] }]]));
    const ops = tmp("ops");
    const denLocal = join(tmp("den"), "kb");
    const r = emitCrawl(runDir, { wolf: "w", sinkBase: tmp("emit-sink"), quiet: true, roots: { opsRoot: ops, kbBase: "", denLocal } });
    expect(r.emitted).toBe(1);
    expect(r.dest).toBe(`${ops}/inbox/w`);
    expect(readdirSync(join(ops, "inbox", "w")).length).toBeGreaterThan(0);
    expect(existsSync(denLocal)).toBe(true);
    // nothing under the env paths
    expect(readdirSync(envOps)).toEqual([]);
    expect(readdirSync(envDen)).toEqual([]);
  });
});

describe("runCrawl kbBase", () => {
  it("an explicit empty kbBase ignores the process env KB_BASE", () => {
    const kb = tmp("kb");
    mkdirSync(join(kb, "domains", "d"), { recursive: true });
    writeFileSync(join(kb, "domains", "d", "_digest.json"), JSON.stringify({ domain: "d", entries: [] }));
    vi.stubEnv("KB_BASE", kb);
    expect(loadPublishedDigest("d")).toBeDefined(); // the env fallback still works for pi
    expect(loadPublishedDigest("d", "")).toBeUndefined(); // an explicit "none" does not fall back
    expect(loadPublishedDigest("d", tmp("other"))).toBeUndefined();
  });
});
