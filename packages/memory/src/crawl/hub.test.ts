/** Releasing a crawl: with a hub configured the contributions are POSTed (wolf actor header); without, the inbox files are written as before. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitCrawl } from "./emit.js";
import { emitCrawlToHub, hubTargetFromEnv, postContribution, redactUrl } from "./hub.js";
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

function runDirFixture(folders = 1): string {
  const src = tmp("src");
  for (let i = 0; i < folders; i++) {
    mkdirSync(join(src, `f${i}`), { recursive: true });
    writeFileSync(join(src, `f${i}`, "a.md"), `# A${i}\nalpha\n`);
  }
  const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: tmp("sink") });
  const runDir = tmp("run");
  const plan = readPlan(join(sink.dir, "plan.yaml"));
  writeFileSync(join(runDir, "plan.yaml"), readFileSync(join(sink.dir, "plan.yaml")));
  writeFileSync(join(runDir, "topics.json"), JSON.stringify(plan.batches.map((b, i) => [b.topic, { title: `T${i}`, summary: "s", body: `body text ${i}`, events: [] }])));
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

describe("emitCrawlToHub failure handling", () => {
  const created = (n: number) => Response.json({ id: `x${n}.md`, wolf: "w", duplicate: false }, { status: 201 });

  it("a partial POST failure (1 posted, then an error) throws; the retry lands the rest and the hub's duplicate answer is fine", async () => {
    const runDir = runDirFixture(3);
    const denLocal = join(tmp("den"), "kb");
    const roots = { opsRoot: tmp("ops"), kbBase: "", denLocal };
    const stored = new Set<string>();
    let call = 0;
    const flaky = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { denTopicId: string };
      if (++call === 2) return Response.json({ code: "busy", message: "try later" }, { status: 409 });
      const dup = stored.has(b.denTopicId);
      stored.add(b.denTopicId);
      return Response.json({ id: `${b.denTopicId}.md`, wolf: "w", duplicate: dup }, { status: dup ? 200 : 201 });
    }) as unknown as typeof fetch;
    const opts = { wolf: "w", sinkBase: tmp("s"), quiet: true, roots };
    await expect(emitCrawlToHub(runDir, { baseUrl: "http://h", fetch: flaky }, opts)).rejects.toThrow(/409.*try later/);
    expect(stored.size).toBe(1);
    expect(existsSync(join(denLocal, "emitted.json"))).toBe(false); // restored: nothing counts as sent
    const retry = await emitCrawlToHub(runDir, { baseUrl: "http://h", fetch: flaky }, opts);
    expect(retry.emitted).toBe(3);
    expect(stored.size).toBe(3);
    expect(call).toBe(5); // 2 + 3 (the first one answered duplicate)
  });

  it("emitCrawl throwing leaves a previous emitted.json as it was and surfaces the error", async () => {
    const denLocal = join(tmp("den"), "kb");
    mkdirSync(denLocal, { recursive: true });
    writeFileSync(join(denLocal, "emitted.json"), '{"keep":"me"}');
    const fetchStub = (async () => created(1)) as unknown as typeof fetch;
    await expect(emitCrawlToHub(join(tmp("no-run"), "missing"), { baseUrl: "http://h", fetch: fetchStub }, { wolf: "w", sinkBase: tmp("s"), quiet: true, roots: { opsRoot: tmp("ops"), kbBase: "", denLocal } })).rejects.toThrow();
    expect(readFileSync(join(denLocal, "emitted.json"), "utf-8")).toBe('{"keep":"me"}');
  });

  it("a 2xx without a stored id is an error", async () => {
    const noId = (async () => Response.json({ ok: true }, { status: 201 })) as unknown as typeof fetch;
    await expect(postContribution({ baseUrl: "http://h", fetch: noId }, "w", {})).rejects.toThrow(/without a stored id/);
  });

  it("each post carries a timeout signal", async () => {
    let signal: AbortSignal | null | undefined;
    const spy = (async (_u: string, init: RequestInit) => ((signal = init.signal), created(1))) as unknown as typeof fetch;
    await postContribution({ baseUrl: "http://h", fetch: spy }, "w", {});
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("credentials in the hub URL are stripped from dest, the request URL, and error text", async () => {
    expect(redactUrl("https://u:p@h.example:1/base/?k=v#f")).toBe("https://h.example:1/base");
    const seen: string[] = [];
    const ok = (async (u: string) => (seen.push(u), created(1))) as unknown as typeof fetch;
    const r = await emitCrawlToHub(runDirFixture(), { baseUrl: "https://u:p@h.example", fetch: ok }, { wolf: "w", sinkBase: tmp("s"), quiet: true, roots: { opsRoot: tmp("ops"), kbBase: "", denLocal: join(tmp("den"), "kb") } });
    expect(r.dest).toBe("https://h.example/v1/contributions");
    expect(seen).toEqual(["https://h.example/v1/contributions"]);
    const boom = (async () => {
      throw new Error("connect ECONNREFUSED https://u:p@h.example/v1/contributions");
    }) as unknown as typeof fetch;
    const err = await postContribution({ baseUrl: "https://u:p@h.example", fetch: boom }, "w", {}).catch((e: Error) => e);
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).not.toMatch(/u:p/);
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
