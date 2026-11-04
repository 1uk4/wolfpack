/** Hub crawl endpoints: receipts, contribution check, kb/match (embeddings mocked + text fallback + duplicate threshold), hub-side secret rejection. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { contributionFileName } from "@wolfpack/kb/client";
import { checkHubContributions, checkHubContributionsDetailed, readHubReceipts, readHubReceiptsDetailed } from "@wolfpack/memory";
import { createHubServer, type HubServer } from "./server.js";
import { wolfCast, bearer, mintOperatorToken, registerWolfOnHost } from "./testing/tokens.js";
import { contributionsDir, hubRoots } from "./layout.js";
import { DUPLICATE_BODY_SIMILARITY, EMBEDDING_THRESHOLDS, TEXT_THRESHOLDS, bodySimilarity, createEmbeddingCache, matchKb, type OllamaConfig } from "./crawl-endpoints.js";
import { storeContribution, ContributionError } from "./contributions.js";
import { patternsIn, MAX_SCAN_CHARS, UNSCANNED } from "./secret-check.js";

const dataDir = mkdtempSync(join(tmpdir(), "hubd-crawlep-"));
let hub: HubServer;
let ollamaUp = true;
let ollamaCalls = 0;
let cast: Awaited<ReturnType<typeof wolfCast>>;
const BODY = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.";

// Fake embedding: a 3-dim vector from keyword presence, so scores are predictable.
const vecOf = (t: string): number[] => [/alpha/i.test(t) ? 1 : 0, /pizza/i.test(t) ? 1 : 0, 0.01];
const fakeFetch = (async (_u: unknown, init?: { body?: string }) => {
  ollamaCalls++;
  if (!ollamaUp) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  const { input } = JSON.parse(init!.body!) as { input: string[] };
  return Response.json({ embeddings: input.map(vecOf) });
}) as unknown as typeof fetch;

function seedEntry(domain: string, id: string, title: string, body: string) {
  const dir = join(hubRoots(dataDir).kbBase, "domains", domain, "entries");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: "${title}"\ndomain: ${domain}\n---\n\n${body}\n`);
}

beforeAll(async () => {
  seedEntry("wolfpack", "kb-alpha-aaaaaaa", "Alpha notes", BODY);
  seedEntry("wolfpack", "kb-pizza-bbbbbbb", "Pizza dough", "Flour water salt yeast. Knead and rest overnight in the fridge for best flavour.");
  seedEntry("other", "kb-alpha-ccccccc", "Alpha elsewhere", BODY);
  hub = await createHubServer({ dataDir, ollama: { url: "http://ollama.invalid", fetch: fakeFetch, model: "m" } });
  cast = await wolfCast(hub, ["w1", "w2"], "wolfpack");
});
afterAll(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path: string, h: Record<string, string>) => fetch(`${hub.url}${path}`, { headers: h });
const post = (path: string, body: unknown, h: Record<string, string>, url = hub.url) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
const contribution = (from: string, topic: string, body = "The body.", summary = "Summary.") => ({
  from, denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null,
  domainHint: "wolfpack", summary, submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src",
});

describe("auth", () => {
  it("every endpoint needs a token", async () => {
    expect((await get("/v1/contributions/receipts", {})).status).toBe(401);
    expect((await post("/v1/contributions/check", { items: [] }, {})).status).toBe(401);
    expect((await post("/v1/kb/match", { candidates: [{ title: "t", body: "b" }] }, {})).status).toBe(401);
    expect((await get("/v1/contributions/receipts", bearer("nope"))).status).toBe(401);
  });
});

describe("receipts + check", () => {
  it("receipts list the curated topics of the calling wolf only; check scopes to the wolf and needs the exact hash", async () => {
    const c = contribution("w1", "crawl-wolfpack-docs", "docs body");
    expect((await post("/v1/contributions", c, cast.wolves.w1)).status).toBe(201);
    expect(await (await get("/v1/contributions/receipts", cast.wolves.w1)).json()).toEqual({ curated: [] }); // pending, not curated
    const items = [{ denTopicId: "crawl-wolfpack-docs", contentHash: c.contentHash }];
    expect(await (await post("/v1/contributions/check", { items }, cast.wolves.w1)).json()).toEqual({ unchanged: ["crawl-wolfpack-docs"] });
    expect(await (await post("/v1/contributions/check", { items }, cast.wolves.w2)).json()).toEqual({ unchanged: [] });
    const other = [{ denTopicId: "crawl-wolfpack-docs", contentHash: contentHash("different") }, { denTopicId: "crawl-wolfpack-docs" }];
    expect(await (await post("/v1/contributions/check", { items: other }, cast.wolves.w1)).json()).toEqual({ unchanged: [] });
    // the curator handles it: the file moves to _processed
    const lane = contributionsDir(dataDir, "w1");
    mkdirSync(join(lane, "_processed"), { recursive: true });
    const name = contributionFileName("crawl-wolfpack-docs", c.contentHash);
    expect(readdirSync(lane)).toContain(name);
    writeFileSync(join(lane, "_processed", name), "x");
    rmSync(join(lane, name));
    expect(await (await get("/v1/contributions/receipts", cast.wolves.w1)).json()).toEqual({ curated: ["crawl-wolfpack-docs"] });
    expect(await (await get("/v1/contributions/receipts", cast.wolves.w2)).json()).toEqual({ curated: [] });
    expect(await (await post("/v1/contributions/check", { items }, cast.wolves.w1)).json()).toEqual({ unchanged: ["crawl-wolfpack-docs"] });
  });

  it("a worker may not name another host's wolf; an operator must name the wolf", async () => {
    expect((await get("/v1/contributions/receipts?wolf=w2", cast.wolves.w1)).status).toBe(403);
    expect((await get("/v1/contributions/receipts", cast.operator)).status).toBe(400);
    expect((await get("/v1/contributions/receipts?wolf=w1", cast.operator)).status).toBe(200);
    expect((await get("/v1/contributions/receipts?wolf=..", cast.operator)).status).toBe(400);
    expect((await post("/v1/contributions/check", { items: "x" }, cast.wolves.w1)).status).toBe(400);
  });

  it("the wolf-side client reads the real contracts", async () => {
    const target = { baseUrl: hub.url, token: cast.wolves.w1.Authorization.replace(/^Bearer /, "") };
    expect([...(await readHubReceipts(target))!]).toEqual(["crawl-wolfpack-docs"]);
    const unchanged = await checkHubContributions(target, [{ denTopicId: "crawl-wolfpack-docs", contentHash: contentHash("docs body") }, { denTopicId: "nope", contentHash: contentHash("x") }]);
    expect([...unchanged!]).toEqual(["crawl-wolfpack-docs"]);
  });
});

describe("kb/match", () => {
  const dup = { title: "Alpha notes", body: BODY };
  it("embeddings: score >= 0.9 with a near-identical body is a duplicate; same score, different body is an update; unrelated is new", async () => {
    ollamaUp = true;
    const changed = "Alpha only shares the first word. Everything else here is entirely different prose about something unrelated to the original text at all.";
    const r = await (await post("/v1/kb/match", { candidates: [dup, { title: "Alpha again", body: changed }, { title: "Weather", body: "Rain tomorrow." }] }, cast.operator)).json();
    expect(r.method).toBe("embeddings");
    expect(r.fallback).toBeUndefined();
    expect(r.results[0].label).toBe("duplicate");
    expect(r.results[0].matches[0]).toMatchObject({ id: expect.stringMatching(/^kb-alpha-/), score: 1, bodySimilarity: 1 });
    expect(r.results[1].matches[0].score).toBeGreaterThanOrEqual(0.9);
    expect(r.results[1].matches[0].bodySimilarity).toBeLessThan(DUPLICATE_BODY_SIMILARITY);
    expect(r.results[1].label).toBe("update");
    expect(r.results[2].label).toBe("new");
  });

  it("falls back to text matching when Ollama is down, and says so", async () => {
    ollamaUp = false;
    const before = ollamaCalls;
    const res = await post("/v1/kb/match", { candidates: [dup, { title: "Alpha notes", body: BODY + " One more sentence appended with several other words to shift it." }, { title: "Weather", body: "Rain tomorrow." }] }, cast.operator);
    ollamaUp = true;
    expect(res.status).toBe(200);
    expect(ollamaCalls).toBeGreaterThan(before);
    const r = await res.json();
    expect(r.method).toBe("text");
    expect(r.fallback).toMatch(/unavailable/);
    expect(r.fallback).not.toMatch(/ollama\.invalid|127\.0\.0\.1:11434/);
    expect(r.results[0].label).toBe("duplicate");
    expect(r.results[1].label).toBe("update");
    expect(r.results[2].label).toBe("new");
  });

  it("an empty KB answers method text with a reason; with entries but no service the reason says so", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "hubd-crawlep2-"));
    const h2 = await createHubServer({ dataDir: d2, ollama: {} });
    try {
      const op = bearer(mintOperatorToken(d2));
      const r = await (await post("/v1/kb/match", { candidates: [{ title: "x", body: "y" }] }, op, h2.url)).json();
      expect(r).toMatchObject({ method: "text", fallback: "no KB entries in scope to match against", results: [{ label: "new", matches: [] }] }); // an empty KB is never "embeddings"
    } finally {
      await h2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("scopes a worker to its subscribed domains and validates the body", async () => {
    const r = await (await post("/v1/kb/match", { candidates: [dup] }, cast.wolves.w1)).json(); // w1's host subscribes to no domain
    expect(r.results[0]).toMatchObject({ label: "new", matches: [] });
    expect((await post("/v1/kb/match", { candidates: [{ ...dup, domain: "wolfpack" }] }, cast.wolves.w1)).status).toBe(403);
    const all = await (await post("/v1/kb/match", { candidates: [dup] }, cast.operator)).json();
    expect(all.results[0].matches.map((m: { domain: string }) => m.domain).sort()).toEqual(["other", "wolfpack"]);
    const one = await (await post("/v1/kb/match", { candidates: [{ ...dup, domain: "other" }] }, cast.operator)).json();
    expect(one.results[0].matches.map((m: { domain: string }) => m.domain)).toEqual(["other"]);
    expect((await post("/v1/kb/match", { candidates: [] }, cast.operator)).status).toBe(400);
    expect((await post("/v1/kb/match", { nope: 1 }, cast.operator)).status).toBe(400);
  });

  it("bodySimilarity: identical 1, disjoint 0; one changed word in 60 stays above the duplicate threshold, half the text does not", () => {
    expect(bodySimilarity(BODY, BODY.toUpperCase())).toBe(1);
    expect(bodySimilarity("a b c d", "e f g h")).toBe(0);
    const base = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const edited = bodySimilarity(base, base.replace("w30", "x"));
    expect(edited).toBeLessThan(1);
    expect(edited).toBeGreaterThanOrEqual(DUPLICATE_BODY_SIMILARITY);
    expect(bodySimilarity(base, base.split(" ").slice(0, 30).join(" "))).toBeLessThan(DUPLICATE_BODY_SIMILARITY);
  });
});

describe("kb/match internals", () => {
  const roots = { kbBase: hubRoots(dataDir).kbBase };
  const cand = [{ title: "Alpha notes", body: BODY }];
  const base = (over: Partial<OllamaConfig> = {}): OllamaConfig => ({ url: "http://ollama.invalid", fetch: fakeFetch, model: "m", ...over });
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("no service configured, with entries: text, 'no embedding service configured'", async () => {
    const r = await matchKb(roots, cand, {});
    expect(r).toMatchObject({ method: "text", fallback: "no embedding service configured" });
    expect(r.results[0]!.label).toBe("duplicate");
  });

  it("an Ollama timeout falls back to text with a reason (no URL in it)", async () => {
    const w = quiet();
    const hang = ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) as unknown as typeof fetch;
    const r = await matchKb(roots, cand, base({ fetch: hang, timeoutMs: 30 }));
    expect(r.method).toBe("text");
    expect(r.fallback).toMatch(/timed out/);
    expect(r.fallback).not.toMatch(/ollama\.invalid/);
    w.mockRestore();
  });

  it("the overall deadline stops a slow multi-batch run and falls back, naming the deadline", async () => {
    const w = quiet();
    seedMany("many", 70); // 70 docs -> 3 batches after the candidate batch
    const slow = (async (u: unknown, init: { body: string }) => { await new Promise((r) => setTimeout(r, 40)); return fakeFetch(u as string, init); }) as unknown as typeof fetch;
    const r = await matchKb(roots, [{ ...cand[0]!, domain: "many" }], base({ fetch: slow, deadlineMs: 100 }), undefined, createEmbeddingCache());
    expect(r.method).toBe("text");
    expect(r.fallback).toMatch(/deadline/);
    w.mockRestore();
  });

  it("malformed payloads fall back, saying which batch failed: bad status, bad json, wrong count, non-numbers", async () => {
    const w = quiet();
    const cases: [string, typeof fetch, RegExp][] = [
      ["status", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, /answered 500/],
      ["json", (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch, /unreadable/],
      ["count", (async () => Response.json({ embeddings: [[1, 2]] })) as unknown as typeof fetch, /malformed/],
      ["numbers", (async () => Response.json({ embeddings: [["a", "b"]] })) as unknown as typeof fetch, /malformed/],
    ];
    for (const [, f, re] of cases) {
      const r = await matchKb(roots, cand, base({ fetch: f }));
      expect(r.method).toBe("text");
      expect(r.fallback).toMatch(/batch 1\/1/);
      expect(r.fallback).toMatch(re);
    }
    w.mockRestore();
  });

  it("a failing KB-entry batch is named as such", async () => {
    const w = quiet();
    let n = 0;
    const f = (async (u: unknown, init: { body: string }) => (++n === 1 ? fakeFetch(u as string, init) : new Response("x", { status: 503 }))) as unknown as typeof fetch;
    const r = await matchKb(roots, [{ ...cand[0]!, domain: "wolfpack" }], base({ fetch: f }), undefined, createEmbeddingCache());
    expect(r.fallback).toMatch(/KB entry batch 1\/1/);
    w.mockRestore();
  });

  it("differing embedding dimensions are an embedding failure (text, with a reason), not a wall of 'new'", async () => {
    const w = quiet();
    const f = (async (_u: unknown, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return Response.json({ embeddings: input.map((t) => (/^Alpha notes/.test(t) && !/Flour/.test(t) && input.length === 1 ? [1, 0] : [1, 0, 0])) });
    }) as unknown as typeof fetch;
    const r = await matchKb(roots, cand, base({ fetch: f }), undefined, createEmbeddingCache());
    expect(r.method).toBe("text");
    expect(r.fallback).toMatch(/dimensions differ/);
    expect(r.results[0]!.label).toBe("duplicate"); // text matching still labels it
    w.mockRestore();
  });

  it("embeds only the requested domain's entries, and caches them (a repeat embeds only the candidate); an edited entry is re-embedded", async () => {
    let inputs = 0;
    const counting = (async (u: unknown, init: { body: string }) => { inputs += (JSON.parse(init.body) as { input: string[] }).input.length; return fakeFetch(u as string, init); }) as unknown as typeof fetch;
    const cache = createEmbeddingCache();
    const one = [{ ...cand[0]!, domain: "other" }]; // 1 entry in "other"
    await matchKb(roots, one, base({ fetch: counting }), undefined, cache);
    expect(inputs).toBe(1 + 1); // candidate + the one entry of that domain, not the whole KB
    inputs = 0;
    await matchKb(roots, one, base({ fetch: counting }), undefined, cache);
    expect(inputs).toBe(1); // candidate only
    seedEntry("other", "kb-alpha-ccccccc", "Alpha elsewhere", BODY + " Edited.");
    inputs = 0;
    await matchKb(roots, one, base({ fetch: counting }), undefined, cache);
    expect(inputs).toBe(2); // the edited entry is embedded again
    seedEntry("other", "kb-alpha-ccccccc", "Alpha elsewhere", BODY);
    // a worker's readable set limits what is loaded even for a candidate without a domain
    inputs = 0;
    await matchKb(roots, cand, base({ fetch: counting }), new Set(["other"]), createEmbeddingCache());
    expect(inputs).toBe(2);
    // an unreadable named domain contributes nothing
    const none = await matchKb(roots, [{ ...cand[0]!, domain: "wolfpack" }], base({ fetch: counting }), new Set(["other"]), createEmbeddingCache());
    expect(none).toMatchObject({ method: "text", fallback: "no KB entries in scope to match against" });
  });

  it("caps the docs embedded per call: falls back saying the cache is warming, and the next call has more cached", async () => {
    const w = quiet();
    seedMany("cap", 5);
    const cache = createEmbeddingCache();
    const r1 = await matchKb(roots, [{ ...cand[0]!, domain: "cap" }], base({ maxDocs: 3 }), undefined, cache);
    expect(r1.method).toBe("text");
    expect(r1.fallback).toMatch(/warming the embedding cache \(3 of 5/);
    const r2 = await matchKb(roots, [{ ...cand[0]!, domain: "cap" }], base({ maxDocs: 3 }), undefined, cache);
    expect(r2.method).toBe("embeddings");
    w.mockRestore();
  });

  it("thresholds are separate per method", () => {
    expect(EMBEDDING_THRESHOLDS).not.toBe(TEXT_THRESHOLDS);
    expect(TEXT_THRESHOLDS.update).toBeLessThan(EMBEDDING_THRESHOLDS.update);
  });
});

function seedMany(domain: string, n: number) {
  for (let i = 0; i < n; i++) seedEntry(domain, `kb-${domain}-${String(i).padStart(7, "0")}`, `Entry ${i}`, `Body number ${i} with some pizza words`);
}

describe("kb/match access", () => {
  it("never runs without an identity: no token and a garbage token are 401, and never list any domain", async () => {
    const r = await post("/v1/kb/match", { candidates: [{ title: "Alpha notes", body: BODY }] }, {});
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("kb-alpha");
    expect((await post("/v1/kb/match", { candidates: [{ title: "Alpha notes", body: BODY }] }, bearer("nope"))).status).toBe(401);
  });

  it("the schema owns the 50-candidate limit", async () => {
    const many = Array.from({ length: 51 }, () => ({ title: "t", body: "b" }));
    expect((await post("/v1/kb/match", { candidates: many }, cast.operator)).status).toBe(400);
  });
});

describe("check hardening + client", () => {
  it("a traversal denTopicId in check is never 'unchanged' and touches nothing; over-long ids and more than 2000 items are 400", async () => {
    const items = [{ denTopicId: "../x", contentHash: contentHash("a") }, { denTopicId: "a/b", contentHash: contentHash("a") }];
    const r = await post("/v1/contributions/check", { items }, cast.wolves.w1);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ unchanged: [] });
    expect((await post("/v1/contributions/check", { items: [{ denTopicId: "x".repeat(201) }] }, cast.wolves.w1)).status).toBe(400);
    expect((await post("/v1/contributions/check", { items: [{ denTopicId: "x", contentHash: "h".repeat(201) }] }, cast.wolves.w1)).status).toBe(400);
    const big = Array.from({ length: 2001 }, (_, i) => ({ denTopicId: `t${i}` }));
    expect((await post("/v1/contributions/check", { items: big }, cast.wolves.w1)).status).toBe(400);
  });

  it("the client chunks check calls at 2000 items, merges the answers, and skips the call for zero items", async () => {
    const calls: number[] = [];
    const f = (async (_u: unknown, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: { denTopicId: string }[] };
      calls.push(items.length);
      return Response.json({ unchanged: items.filter((i) => i.denTopicId.endsWith("0")).map((i) => i.denTopicId) });
    }) as unknown as typeof fetch;
    const items = Array.from({ length: 4500 }, (_, i) => ({ denTopicId: `t${i}`, contentHash: "sha256:" + "0".repeat(64) }));
    const r = await checkHubContributionsDetailed({ baseUrl: "http://hub", fetch: f }, items, "w1");
    expect(calls).toEqual([2000, 2000, 500]);
    expect(r.value!.size).toBe(450);
    calls.length = 0;
    expect((await checkHubContributionsDetailed({ baseUrl: "http://hub", fetch: f }, [], "w1")).value!.size).toBe(0);
    expect(calls).toEqual([]);
    // one failing chunk makes the whole answer unknown, with a reason
    let n = 0;
    const flaky = (async () => (++n === 2 ? new Response("{}", { status: 503 }) : Response.json({ unchanged: [] }))) as unknown as typeof fetch;
    const bad = await checkHubContributionsDetailed({ baseUrl: "http://hub", fetch: flaky }, items, "w1");
    expect(bad.value).toBeUndefined();
    expect(bad.reason).toMatch(/answered 503/);
  });

  it("two active wolves on one host: without ?wolf the hub answers 400 and the client says why; with the wolf the real client works", async () => {
    const token = await registerWolfOnHost(hub, cast.operator, "ma", "h-multi");
    await registerWolfOnHost(hub, cast.operator, "mb", "h-multi");
    const c = contribution("mb", "crawl-wolfpack-multi", "multi body");
    expect((await post("/v1/contributions", c, token)).status).toBe(201);
    const target = { baseUrl: hub.url, token: token.Authorization.replace(/^Bearer /, "") };
    const noWolf = await readHubReceiptsDetailed(target);
    expect(noWolf.value).toBeUndefined();
    expect(noWolf.reason).toMatch(/hub answered 400.*several active wolves/);
    const noWolfCheck = await checkHubContributionsDetailed(target, [{ denTopicId: "crawl-wolfpack-multi", contentHash: c.contentHash }]);
    expect(noWolfCheck.value).toBeUndefined();
    expect(noWolfCheck.reason).toMatch(/400/);
    // with ?wolf=: mb holds it, ma does not
    expect([...(await checkHubContributions(target, [{ denTopicId: "crawl-wolfpack-multi", contentHash: c.contentHash }], "mb"))!]).toEqual(["crawl-wolfpack-multi"]);
    expect([...(await checkHubContributions(target, [{ denTopicId: "crawl-wolfpack-multi", contentHash: c.contentHash }], "ma"))!]).toEqual([]);
    expect((await readHubReceiptsDetailed(target, "ma")).value).toEqual(new Set());
    // a wolf of another host stays 403, with a reason
    const other = await readHubReceiptsDetailed(target, "w1");
    expect(other.value).toBeUndefined();
    expect(other.reason).toMatch(/403/);
  });

  it("an unreachable hub and an older hub (404) both give a reason", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED http://secret-host"); }) as unknown as typeof fetch;
    const r1 = await readHubReceiptsDetailed({ baseUrl: "http://hub", fetch: down });
    expect(r1.reason).toBe("hub receipts: hub unreachable");
    const old = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect((await checkHubContributionsDetailed({ baseUrl: "http://hub", fetch: old }, [{ denTopicId: "t" }])).reason).toMatch(/older hub/);
  });
});

describe("secret check on contributions", () => {
  const FAKE = "sk-" + "FAKEFAKEFAKEFAKEFAKEFAKE1234";
  const crawl = (from: string, topic: string, body = "ok body", extra: Record<string, unknown> = {}) => ({ ...contribution(from, topic, body), ...extra });
  const lane = (w: string) => { try { return readdirSync(contributionsDir(dataDir, w)); } catch { return [] as string[]; } };

  it("crawl: rejects with field + pattern + a short ref, never the value nor the topic id; stores nothing (not even in _bad)", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    const topic = `crawl-wolfpack-leaky-${FAKE}`; // a caller-supplied id that itself carries a secret
    const res = await post("/v1/contributions", crawl("w2", topic, `config\nOPENAI_KEY=${FAKE}\n`), cast.wolves.w2);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("body");
    expect(text).toContain("token");
    expect(text).toMatch(/entry ref [0-9a-f]{8}/);
    expect(text).not.toContain("FAKEFAKE");
    expect(text).not.toContain("crawl-wolfpack-leaky");
    expect(JSON.stringify(w.mock.calls)).not.toContain("FAKEFAKE");
    expect(lane("w2").filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(lane("w2")).not.toContain("_bad");
    w.mockRestore();
  });

  it("crawl: EVERY string field is scanned, not only body/summary (sourcePath, host, session)", async () => {
    for (const field of ["sourcePath", "host", "session", "summary"]) {
      const res = await post("/v1/contributions", crawl("w2", `crawl-wolfpack-f-${field}`, `ok ${field}`, { [field]: `/x/${FAKE}` }), cast.wolves.w2);
      expect(res.status, field).toBe(400);
      expect(await res.text()).toContain(field);
    }
  });

  it("non-crawl contributions are NOT rejected: stored, with a warning naming pattern and entry id (no value)", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = { ...contribution("w2", "topic-live", `note: token: work-wolfpack-ZBZPAZ9 and ${FAKE}`), origin: undefined };
    const res = await post("/v1/contributions", c, cast.wolves.w2);
    expect(res.status).toBe(201);
    const logged = JSON.stringify(w.mock.calls);
    expect(logged).toContain("topic-live");
    expect(logged).toContain("token");
    expect(logged).not.toContain("FAKEFAKE");
    w.mockRestore();
  });

  it("authorization comes first: a worker posting as another host's wolf is 403, not a secret finding", async () => {
    const res = await post("/v1/contributions", crawl("w1", "crawl-wolfpack-x", `k=${FAKE}`), cast.wolves.w2);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/secret/);
  });

  it("a malformed crawl contribution is quarantined WITHOUT the secret", async () => {
    const bad = { ...crawl("w2", "crawl-wolfpack-badshape", `x ${FAKE}`), change: "bogus" };
    expect((await post("/v1/contributions", bad, cast.wolves.w2)).status).toBe(400);
    const dir = join(contributionsDir(dataDir, "w2"), "_bad");
    const raws = readdirSync(dir).filter((f) => f.endsWith(".raw"));
    expect(raws.length).toBeGreaterThan(0);
    for (const f of raws) expect(readFileSync(join(dir, f), "utf-8")).not.toContain("FAKEFAKE");
  });

  it("the same check runs on the link path (storeContribution directly): crawl throws ContributionError", () => {
    const body = `a ${FAKE}`;
    const c = crawl("w2", "crawl-wolfpack-link", body);
    expect(() => storeContribution(dataDir, { id: "w2", kind: "wolf" }, { text: JSON.stringify(c), json: c })).toThrow(ContributionError);
  });

  it("scanning is bounded: a long run of 'a.' is fast, a secret is still found at a window edge, and an oversize field is reported unscanned", () => {
    const run = "a.".repeat(60_000); // 120 KB: the unwindowed scanner takes ~35 s on this
    const t = Date.now();
    expect(patternsIn(run)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
    const secret = `OPENAI_API_KEY=${FAKE}`;
    for (const pad of [0, 1790, 1791, 1792, 1800, 1900, 4000]) expect(patternsIn("x ".repeat(pad / 2) + secret)).toContain("token");
    expect(patternsIn("a".repeat(MAX_SCAN_CHARS + 1))).toEqual([UNSCANNED]);
    expect(patternsIn("w".repeat(100_000))).toEqual([]);
  });

  it("an oversize crawl field fails closed", async () => {
    const res = await post("/v1/contributions", crawl("w2", "crawl-wolfpack-huge", "y".repeat(MAX_SCAN_CHARS + 10)), cast.wolves.w2);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unscanned");
  });

  it("clean crawl contributions pass", async () => {
    expect((await post("/v1/contributions", crawl("w2", "crawl-wolfpack-clean", "nothing secret here, a token is mentioned only in passing"), cast.wolves.w2)).status).toBe(201);
  });

  it("KNOWN over-rejection (uncalibrated pattern): crawl prose like 'token: work-wolfpack-ZBZPAZ9' IS refused; the owner has no-override for crawl, so the entry is edited", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post("/v1/contributions", crawl("w2", "crawl-wolfpack-prose", "see token: work-wolfpack-ZBZPAZ9 for details"), cast.wolves.w2);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("credential assignment");
    w.mockRestore();
  });
});
