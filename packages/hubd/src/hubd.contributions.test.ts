/** POST /v1/contributions: the on-disk layout, quarantine, idempotency, intake compatibility, and a crawl release against a real hubd. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { drainInbox } from "@wolfpack/kb/librarian";
import { emitCrawl, emitCrawlToHub, planCrawl, readPlan } from "@wolfpack/memory";
import { createHubServer, type HubServer } from "./server.js";
import { contributionsDir, contributionsRoot } from "./layout.js";

const KEY = "k";
const dataDir = mkdtempSync(join(tmpdir(), "hubd-contrib-"));
const extra: string[] = [];
let hub: HubServer;
beforeAll(async () => {
  hub = await createHubServer({ dataDir, apiKey: KEY });
});
afterAll(async () => {
  await hub.close();
  for (const d of [dataDir, ...extra]) rmSync(d, { recursive: true, force: true });
});

const as = (id: string, kind: "wolf" | "operator" = "wolf") => ({ [ACTOR_HEADER]: JSON.stringify({ id, kind }) });
const post = (body: unknown, headers: Record<string, string>) =>
  fetch(`${hub.url}/v1/contributions`, { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
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
    // The existing intake, run over a roots whose lane dir is `inbox/` (the sfo-01 name), parses the identical file.
    const ops = mkdtempSync(join(tmpdir(), "hubd-intake-"));
    extra.push(ops);
    const lane = join(ops, "inbox", "fenrir");
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(lane, { recursive: true });
    copyFileSync(join(dir, ack.id), join(lane, ack.id));
    const [parsed] = drainInbox({ kbBase: join(ops, "base"), opsRoot: ops, denLocal: ops });
    expect(parsed).toMatchObject({ from: "fenrir", denTopicId: "topic-a", origin: "crawl", sourcePath: "/src", contentHash: contentHash("The body.") });
  });

  it("is idempotent on topic + content hash (also once the curator moved it to _processed/)", async () => {
    const c = contribution("fenrir", "topic-b");
    expect((await post(c, as("fenrir"))).status).toBe(201);
    const again = await post(c, as("fenrir"));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const dir = contributionsDir(dataDir, "fenrir");
    expect(readdirSync(dir).filter((f) => f.startsWith("topic-b"))).toHaveLength(1);
    const { mkdirSync, renameSync } = await import("node:fs");
    const name = readdirSync(dir).find((f) => f.startsWith("topic-b"))!;
    mkdirSync(join(dir, "_processed"), { recursive: true });
    renameSync(join(dir, name), join(dir, "_processed", name));
    expect(((await (await post(c, as("fenrir"))).json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(existsSync(join(dir, name))).toBe(false);
    // changed content = a new file
    expect((await post(contribution("fenrir", "topic-b", "Changed."), as("fenrir"))).status).toBe(201);
  });

  it("quarantines a schema-invalid submission in _bad/ with a reason, and answers invalid_request", async () => {
    const { contentHash: _h, ...bad } = contribution("fenrir", "topic-c");
    const res = await post(bad, as("fenrir"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    const badDir = join(contributionsDir(dataDir, "fenrir"), "_bad");
    const files = readdirSync(badDir);
    const reason = files.find((f) => f.endsWith(".reason.txt"))!;
    expect(files).toHaveLength(2);
    expect(readFileSync(join(badDir, reason), "utf-8")).toContain("contentHash");
    expect(JSON.parse(readFileSync(join(badDir, reason.replace(".reason.txt", "")), "utf-8")).denTopicId).toBe("topic-c");
    expect(readdirSync(contributionsDir(dataDir, "fenrir")).some((f) => f.startsWith("topic-c"))).toBe(false);
  });

  it("quarantines a hash that does not match the body and an unsafe topic id", async () => {
    const before = readdirSync(join(contributionsDir(dataDir, "fenrir"), "_bad")).length;
    expect((await post({ ...contribution("fenrir", "topic-d"), contentHash: contentHash("other") }, as("fenrir"))).status).toBe(400);
    expect((await post(contribution("fenrir", "../escape"), as("fenrir"))).status).toBe(400);
    expect(readdirSync(join(contributionsDir(dataDir, "fenrir"), "_bad")).length).toBe(before + 4);
    expect(existsSync(join(dataDir, "kb", "ops", "escape"))).toBe(false);
  });

  it("non-JSON is invalid_request and not quarantined", async () => {
    expect((await post("{nope", as("loki"))).status).toBe(400);
    expect(existsSync(contributionsDir(dataDir, "loki"))).toBe(false);
  });

  it("a wolf may only submit as itself; an operator may submit for any wolf; no actor is rejected", async () => {
    expect((await post(contribution("odin", "t"), as("loki"))).status).toBe(400);
    expect(existsSync(contributionsDir(dataDir, "odin"))).toBe(false);
    expect((await post(contribution("odin", "t"), as("owner", "operator"))).status).toBe(201);
    expect(readdirSync(contributionsDir(dataDir, "odin")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect((await post(contribution("odin", "t2"), {})).status).toBe(400);
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

    const viaHub = await emitCrawlToHub(runDir, { baseUrl: hub.url, apiKey: KEY }, { wolf: "freki", sinkBase: tmp("s1"), quiet: true, roots: roots(tmp("ops1")) });
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
