/** Hub crawl endpoints: receipts, contribution check, kb/match (embeddings mocked + text fallback + duplicate threshold), hub-side secret rejection. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { contributionFileName } from "@wolfpack/kb/client";
import { checkHubContributions, readHubReceipts } from "@wolfpack/memory";
import { createHubServer, type HubServer } from "./server.js";
import { wolfCast, bearer, mintOperatorToken } from "./testing/tokens.js";
import { contributionsDir, hubRoots } from "./layout.js";
import { DUPLICATE_BODY_SIMILARITY, bodySimilarity } from "./crawl-endpoints.js";

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

  it("text-only when no embedding service is configured", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "hubd-crawlep2-"));
    const h2 = await createHubServer({ dataDir: d2, ollama: {} });
    try {
      const op = bearer(mintOperatorToken(d2));
      const r = await (await post("/v1/kb/match", { candidates: [{ title: "x", body: "y" }] }, op, h2.url)).json();
      expect(r).toMatchObject({ method: "text", fallback: "no embedding service configured", results: [{ label: "new", matches: [] }] });
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

describe("secret check on contributions", () => {
  const FAKE = "sk-" + "FAKEFAKEFAKEFAKEFAKEFAKE1234";
  it("rejects a flagged entry with entry/field/pattern, never the value, and stores nothing (not even in _bad)", async () => {
    const res = await post("/v1/contributions", contribution("w2", "crawl-wolfpack-leaky", `config\nOPENAI_KEY=${FAKE}\n`), cast.wolves.w2);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("crawl-wolfpack-leaky");
    expect(text).toContain("body");
    expect(text).toContain("token");
    expect(text).not.toContain(FAKE);
    expect(text).not.toContain("FAKEFAKE");
    let files: string[] = [];
    try { files = readdirSync(contributionsDir(dataDir, "w2")); } catch { /* none */ }
    expect(files.filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(files).not.toContain("_bad");
  });

  it("also checks the summary; clean contributions still pass", async () => {
    const bad = await post("/v1/contributions", contribution("w2", "crawl-wolfpack-s", "ok", `uses ${FAKE}`), cast.wolves.w2);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("summary");
    expect((await post("/v1/contributions", contribution("w2", "crawl-wolfpack-clean", "nothing secret here"), cast.wolves.w2)).status).toBe(201);
  });
});
