/** POST /v1/contributions: the on-disk layout, quarantine, idempotency, intake compatibility, and a crawl release against a real hubd. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
import { drainInbox, countPending } from "@wolfpack/kb/librarian";
import { emitCrawl, emitCrawlToHub, planCrawl, readPlan } from "@wolfpack/memory";
import { createHubServer, type HubServer } from "./server.js";
import { wolfCast } from "./testing/tokens.js";
import { CONTRIBUTIONS_LANE, contributionsDir, contributionsRoot } from "./layout.js";
import { MAX_BAD_PER_LANE, MAX_BODY_BYTES, MAX_QUARANTINE_BYTES } from "./contributions.js";

const dataDir = mkdtempSync(join(tmpdir(), "hubd-contrib-"));
const extra: string[] = [];
let hub: HubServer;
beforeAll(async () => {
  hub = await createHubServer({ dataDir });
  const cast = await wolfCast(hub, ["fenrir", "inj", "big", "capped", "huge", "loki", "freki"]);
  creds = { operator: cast.operator, ...cast.wolves };
});
afterAll(async () => {
  await hub.close();
  for (const d of [dataDir, ...extra]) rmSync(d, { recursive: true, force: true });
});

/** operator + one worker token per registered wolf (each on its own host); an unregistered name falls back to the operator token. */
let creds: Record<string, Record<string, string>> = {};
const as = (id: string, kind: "wolf" | "operator" = "wolf") => (kind === "operator" ? creds.operator : creds[id] ?? creds.operator);
const post = (body: unknown, headers: Record<string, string>) =>
  fetch(`${hub.url}/v1/contributions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const contribution = (from: string, topic: string, body = "The body.") => ({
  from, denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null,
  domainHint: "wolfpack", summary: "Summary line.", submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src",
});

describe("contributions on disk", () => {
  it("stores <dataDir>/kb/ops/contributions/<wolf>/<topic>-<hash10>.md, readable by the kb intake", async () => {
    const c = contribution("fenrir", "topic-a");
    const res = await post(c, as("fenrir"));
    expect(res.status).toBe(201);
    const ack = (await res.json()) as { id: string };
    expect(ack.id).toBe(`topic-a-${contentHash("The body.").slice(7, 17)}.md`);
    const dir = contributionsDir(dataDir, "fenrir");
    expect(dir).toBe(join(contributionsRoot(dataDir), "fenrir"));
    expect(readdirSync(dir).filter((f) => !f.startsWith("_"))).toEqual([ack.id]); // no tmp leftovers
    const text = readFileSync(join(dir, ack.id), "utf-8");
    expect(text).toMatch(/^---\nfrom: fenrir\nden_topic_id: topic-a\nchange: create\ncontent_hash: sha256:/);
    expect(text).toContain("\n\nSummary line.\n\nThe body.\n");
    // The existing intake, run over the HUB data dir with the lane option, returns the stored contribution.
    const roots = hubRoots(dataDir);
    expect(CONTRIBUTIONS_LANE).toBe("contributions");
    const mine = drainInbox(roots, { lane: CONTRIBUTIONS_LANE }).filter((p) => p.denTopicId === "topic-a");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: "fenrir", denTopicId: "topic-a", origin: "crawl", sourcePath: "/src", contentHash: contentHash("The body."), summary: "Summary line." });
    expect(countPending(roots.opsRoot, { lane: CONTRIBUTIONS_LANE }).wolves.some((w) => w.startsWith("fenrir("))).toBe(true);
    // The default lane (sfo-01's inbox/) sees nothing of the hub.
    expect(drainInbox(roots)).toEqual([]);
    expect(countPending(roots.opsRoot).total).toBe(0);
  });

  it("is idempotent on topic + content hash (also once the curator moved it to _processed/)", async () => {
    const c = contribution("fenrir", "topic-b");
    expect((await post(c, as("fenrir"))).status).toBe(201);
    const again = await post(c, as("fenrir"));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const dir = contributionsDir(dataDir, "fenrir");
    expect(readdirSync(dir).filter((f) => f.startsWith("topic-b"))).toHaveLength(1);
    const { renameSync } = await import("node:fs");
    const name = readdirSync(dir).find((f) => f.startsWith("topic-b"))!;
    mkdirSync(join(dir, "_processed"), { recursive: true });
    renameSync(join(dir, name), join(dir, "_processed", name));
    expect(((await (await post(c, as("fenrir"))).json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(existsSync(join(dir, name))).toBe(false);
    // changed content = a new file
    expect((await post(contribution("fenrir", "topic-b", "Changed."), as("fenrir"))).status).toBe(201);
  });

  const badDir = (w: string) => join(contributionsDir(dataDir, w), "_bad");
  const rawFiles = (w: string) => readdirSync(badDir(w)).filter((f) => f.endsWith(".raw"));

  it("quarantines a schema-invalid submission in _bad/ (raw copy named by sha256 + reason), and answers invalid_request", async () => {
    const { contentHash: _h, ...bad } = contribution("fenrir", "topic-c");
    const res = await post(bad, as("fenrir"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    const raw = rawFiles("fenrir");
    expect(raw).toHaveLength(1);
    expect(raw[0]).toBe(`${createHash("sha256").update(JSON.stringify(bad)).digest("hex")}.raw`);
    expect(readFileSync(join(badDir("fenrir"), `${raw[0]}.reason.txt`), "utf-8")).toContain("contentHash");
    expect(JSON.parse(readFileSync(join(badDir("fenrir"), raw[0]), "utf-8")).denTopicId).toBe("topic-c");
    expect(readdirSync(contributionsDir(dataDir, "fenrir")).some((f) => f.startsWith("topic-c"))).toBe(false);
    // the same rejected body again is not stored twice
    await post(bad, as("fenrir"));
    expect(rawFiles("fenrir")).toHaveLength(1);
  });

  it("quarantines a hash that does not match the body and an unsafe topic id", async () => {
    const before = rawFiles("fenrir").length;
    expect((await post({ ...contribution("fenrir", "topic-d"), contentHash: contentHash("other") }, as("fenrir"))).status).toBe(400);
    expect((await post(contribution("fenrir", "../escape"), as("fenrir"))).status).toBe(400);
    expect(rawFiles("fenrir").length).toBe(before + 2);
    expect(existsSync(join(dataDir, "kb", "ops", "escape"))).toBe(false);
  });

  it("rejects a line break in any single-line field (frontmatter injection of target: / verbatim:) and stores nothing", async () => {
    const injections: Record<string, unknown>[] = [
      { domainHint: "wolfpack\ntarget: kb-evil" },
      { summary: "s\nverbatim: true" },
      { host: "h\r\nanchor: k\nverbatim: true" },
      { session: "s\ntarget: kb-evil" },
      { sourcePath: "/p\ntarget: kb-evil" },
      { submitted: "2026-10-01 12:00\nverbatim: true" },
      { anchor: "k\n" },
      { target: "kb-x\nverbatim: true" },
      { source: { feature: "f\ntarget: kb-evil" } },
      { source: { tasks: ["t1", "t2\nverbatim: true"] } },
    ];
    for (const [i, inj] of injections.entries()) {
      const res = await post({ ...contribution("inj", `topic-inj${i}`, `Body ${i}.`), ...inj }, as("inj"));
      expect(res.status, JSON.stringify(inj)).toBe(400);
    }
    // from / denTopicId / contentHash with a line break
    expect((await post({ ...contribution("inj", "topic-x"), denTopicId: "a\ntarget: kb-evil" }, as("inj"))).status).toBe(400);
    expect((await post({ ...contribution("inj", "topic-y"), contentHash: contentHash("The body.") + "\nverbatim: true" }, as("inj"))).status).toBe(400);
    expect((await post({ ...contribution("inj", "topic-z"), from: "inj\nverbatim: true" }, as("x", "operator"))).status).toBe(400);
    expect(readdirSync(contributionsDir(dataDir, "inj")).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(readFileSync(join(badDir("inj"), `${rawFiles("inj")[0]}.reason.txt`), "utf-8")).toMatch(/line break/);
    // a body may of course be multi-line (it is not frontmatter)
    expect((await post(contribution("inj", "topic-multi", "line one\n\nline two\n---\nnot frontmatter"), as("inj"))).status).toBe(201);
    const [back] = drainInbox(hubRoots(dataDir), { lane: CONTRIBUTIONS_LANE }).filter((p) => p.from === "inj");
    expect(back.target).toBeUndefined();
    expect(back.verbatim).toBeUndefined();
  });

  it("refuses a value the file format cannot carry faithfully (read-back check) instead of storing it altered", async () => {
    const res = await post({ ...contribution("inj", "topic-pad"), domainHint: "  padded  " }, as("inj"));
    expect(res.status).toBe(400);
    const reasons = rawFiles("inj").map((f) => readFileSync(join(badDir("inj"), `${f}.reason.txt`), "utf-8")).join("\n");
    expect(reasons).toMatch(/domainHint does not survive/);
    expect(readdirSync(contributionsDir(dataDir, "inj")).some((f) => f.startsWith("topic-pad"))).toBe(false);
  });

  it("stores a truncated raw copy (<= 64 KiB) of an oversize rejected body, with the hash of the whole", async () => {
    const big = { ...contribution("big", "topic-big"), summary: "s".repeat(MAX_QUARANTINE_BYTES * 2), contentHash: 5 };
    const text = JSON.stringify(big);
    expect((await post(text, as("big"))).status).toBe(400);
    const [f] = rawFiles("big");
    expect(f).toBe(`${createHash("sha256").update(text).digest("hex")}.raw`);
    expect(statSync(join(badDir("big"), f)).size).toBeLessThan(MAX_QUARANTINE_BYTES + 200);
    expect(readFileSync(join(badDir("big"), `${f}.reason.txt`), "utf-8")).toContain(`bytes: ${Buffer.byteLength(text)}`);
  });

  it("caps _bad/ per lane: past the cap a rejection is still 400 but nothing more is stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = badDir("capped");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < MAX_BAD_PER_LANE; i++) writeFileSync(join(dir, `${String(i).padStart(64, "0")}.raw`), "x");
    expect((await post({ nope: 1, from: "capped" }, as("capped"))).status).toBe(400);
    expect(rawFiles("capped")).toHaveLength(MAX_BAD_PER_LANE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capped/_bad is full"));
    warn.mockRestore();
  });

  it("refuses an oversize body (Content-Length precheck) with invalid_request and closes the connection", async () => {
    const res = await fetch(`${hub.url}/v1/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...as("huge") },
      body: Buffer.alloc(MAX_BODY_BYTES + 1, 97),
    }).catch((e: unknown) => e);
    // either the 400 envelope, or (the server closing early) a reset; never a stored file
    if (res instanceof Response) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/too large/);
    }
    expect(existsSync(contributionsDir(dataDir, "huge"))).toBe(false);
    // the server is still healthy
    expect((await post(contribution("huge", "topic-after"), as("huge"))).status).toBe(201);
  });

  it("non-JSON is invalid_request and not quarantined", async () => {
    expect((await post("{nope", as("loki"))).status).toBe(400);
    expect(existsSync(contributionsDir(dataDir, "loki"))).toBe(false);
  });

  it("a worker token may only submit for wolves on its host; an operator may submit for any wolf; no credentials is 401", async () => {
    expect((await post(contribution("odin", "t"), as("loki"))).status).toBe(403); // odin is not on loki's host
    expect(existsSync(contributionsDir(dataDir, "odin"))).toBe(false);
    expect((await post(contribution("odin", "t"), as("owner", "operator"))).status).toBe(201);
    expect(readdirSync(contributionsDir(dataDir, "odin")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect((await post(contribution("odin", "t2"), {})).status).toBe(401);
  });
});

describe("lane names", () => {
  it("rejects wolf ids starting with _ (_bad, _processed) and uppercase, as a worker's from (403) or an operator's from (400)", async () => {
    for (const id of ["_bad", "_processed", "Wolf", "-x", ".hidden"]) {
      expect((await post(contribution(id, "t-lane"), as("fenrir"))).status, id).toBe(403); // not a wolf on fenrir's host
      expect((await post(contribution(id, "t-lane"), as("owner", "operator"))).status, `op ${id}`).toBe(400);
    }
    expect(existsSync(join(contributionsRoot(dataDir), "_bad"))).toBe(false);
    expect(existsSync(join(contributionsRoot(dataDir), "Wolf"))).toBe(false);
  });

  it("rejects an operator's from that is not a safe segment, and a missing from", async () => {
    for (const from of ["../x", "a/b", "a b", ""]) expect((await post(contribution(from, "t-lane"), as("owner", "operator"))).status, from).toBe(400);
    const { from: _f, ...noFrom } = contribution("x", "t-lane");
    expect((await post(noFrom, as("owner", "operator"))).status).toBe(400);
    expect(readdirSync(contributionsRoot(dataDir)).every((d) => /^[a-z0-9]/.test(d))).toBe(true);
  });

  it("does not echo a long mismatched from in full", async () => {
    const res = await post(contribution("x".repeat(500), "t-lane"), as("loki"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message.length).toBeLessThan(200);
  });
});

describe("crawl release against a real hubd", () => {
  it("emitCrawlToHub lands the same file the inbox emit writes", async () => {
    const tmp = (p: string) => (extra.push(mkdtempSync(join(tmpdir(), `hubd-crawl-${p}-`))), extra[extra.length - 1]);
    const src = tmp("src");
    writeFileSync(join(src, "a.md"), "# A\nalpha\n");
    const { sink } = planCrawl({ source: src, domain: "wolfpack", strategy: "by-folder", sinkBase: tmp("sink") });
    const runDir = tmp("run");
    const plan = readPlan(join(sink.dir, "plan.yaml"));
    writeFileSync(join(runDir, "plan.yaml"), readFileSync(join(sink.dir, "plan.yaml")));
    writeFileSync(join(runDir, "topics.json"), JSON.stringify([[plan.batches[0].topic, { title: "T", summary: "s", body: "body text", events: [] }]]));
    const roots = (ops: string) => ({ opsRoot: ops, kbBase: "", denLocal: join(tmp("den"), "kb") });

    const viaHub = await emitCrawlToHub(runDir, { baseUrl: hub.url, token: creds.freki.Authorization.replace(/^Bearer /, "") }, { wolf: "freki", sinkBase: tmp("s1"), quiet: true, roots: roots(tmp("ops1")) });
    const ops2 = tmp("ops2");
    emitCrawl(runDir, { wolf: "freki", sinkBase: tmp("s2"), quiet: true, roots: roots(ops2) });
    expect(viaHub.emitted).toBe(1);
    const hubFile = readdirSync(contributionsDir(dataDir, "freki")).find((f) => f.endsWith(".md"))!;
    const inboxFile = readdirSync(join(ops2, "inbox", "freki"))[0];
    expect(hubFile).toBe(inboxFile);
    // identical but for the `submitted` minute
    const strip = (t: string) => t.replace(/^submitted: .*$/m, "");
    expect(strip(readFileSync(join(contributionsDir(dataDir, "freki"), hubFile), "utf-8"))).toBe(strip(readFileSync(join(ops2, "inbox", "freki", inboxFile), "utf-8")));
  });
});
