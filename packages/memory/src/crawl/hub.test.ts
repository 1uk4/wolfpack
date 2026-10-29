/** Releasing a crawl: with a hub configured the contributions are POSTed (wolf actor header); without, the inbox files are written as before. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitCrawl } from "./emit.js";
import { emitCrawlToHub, hubTargetFromEnv } from "./hub.js";
import { planCrawl, readPlan } from "./plan.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `crawl-hub-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runDirFixture(): string {
  const src = tmp("src");
  writeFileSync(join(src, "a.md"), "# A\nalpha\n");
  const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: tmp("sink") });
  const runDir = tmp("run");
  const plan = readPlan(join(sink.dir, "plan.yaml"));
  writeFileSync(join(runDir, "plan.yaml"), readFileSync(join(sink.dir, "plan.yaml")));
  writeFileSync(join(runDir, "topics.json"), JSON.stringify([[plan.batches[0].topic, { title: "T", summary: "s", body: "body text", events: [] }]]));
  return runDir;
}

describe("hubTargetFromEnv", () => {
  it("reads WOLFPACK_HUB_URL / WOLFPACK_HUB_KEY; no URL = no hub", () => {
    expect(hubTargetFromEnv({})).toBeUndefined();
    expect(hubTargetFromEnv({ WOLFPACK_HUB_URL: " " })).toBeUndefined();
    expect(hubTargetFromEnv({ WOLFPACK_HUB_URL: "http://h:1", WOLFPACK_HUB_KEY: "k" })).toEqual({ baseUrl: "http://h:1", apiKey: "k" });
  });
});

describe("emitCrawlToHub", () => {
  it("posts each contribution as the wolf, writes nothing to an inbox, and dedups on a resend", async () => {
    const runDir = runDirFixture();
    const denLocal = join(tmp("den"), "kb");
    const sent: { url: string; headers: Record<string, string>; body: { from: string; origin: string; denTopicId: string } }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "x.md", wolf: "w", duplicate: false }), { status: 201 });
    }) as unknown as typeof fetch;
    const opsRoot = tmp("ops");
    const hub = { baseUrl: "http://hub.test/", apiKey: "K", fetch: fetchStub };
    const r = await emitCrawlToHub(runDir, hub, { wolf: "w", sinkBase: tmp("emit-sink"), quiet: true, roots: { opsRoot, kbBase: "", denLocal } });
    expect(r.emitted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://hub.test/v1/contributions");
    expect(sent[0].headers["X-API-Key"]).toBe("K");
    expect(JSON.parse(sent[0].headers["X-Wolfpack-Actor"])).toEqual({ id: "w", kind: "wolf" });
    expect(sent[0].body).toMatchObject({ from: "w", origin: "crawl" });
    expect(existsSync(join(opsRoot, "inbox"))).toBe(false); // the opsRoot is untouched
    expect(readdirSync(opsRoot)).toEqual([]);
    const again = await emitCrawlToHub(runDir, hub, { wolf: "w", sinkBase: tmp("emit-sink"), quiet: true, roots: { opsRoot, kbBase: "", denLocal } });
    expect(again.emitted).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("a rejected post throws and leaves the dedup state as it was, so a retry re-sends", async () => {
    const runDir = runDirFixture();
    const denLocal = join(tmp("den"), "kb");
    const roots = { opsRoot: tmp("ops"), kbBase: "", denLocal };
    const failing = (async () => new Response(JSON.stringify({ code: "invalid_request", message: "nope" }), { status: 400 })) as unknown as typeof fetch;
    await expect(emitCrawlToHub(runDir, { baseUrl: "http://h", fetch: failing }, { wolf: "w", sinkBase: tmp("s"), quiet: true, roots })).rejects.toThrow(/400.*nope/);
    expect(existsSync(join(denLocal, "emitted.json"))).toBe(false);
    let n = 0;
    const ok = (async () => (n++, new Response(JSON.stringify({ id: "x", duplicate: false }), { status: 201 }))) as unknown as typeof fetch;
    const r = await emitCrawlToHub(runDir, { baseUrl: "http://h", fetch: ok }, { wolf: "w", sinkBase: tmp("s"), quiet: true, roots });
    expect([r.emitted, n]).toEqual([1, 1]);
  });
});

describe("emitCrawl (no hub): the inbox path is unchanged", () => {
  it("still writes <opsRoot>/inbox/<wolf>/ and reports the delta", () => {
    const runDir = runDirFixture();
    const opsRoot = tmp("ops");
    const r = emitCrawl(runDir, { wolf: "w", sinkBase: tmp("s"), quiet: true, roots: { opsRoot, kbBase: "", denLocal: join(tmp("den"), "kb") } });
    expect(r.dest).toBe(`${opsRoot}/inbox/w`);
    expect(readdirSync(join(opsRoot, "inbox", "w"))).toHaveLength(1);
    expect(r.delta).toHaveLength(1);
  });
});
