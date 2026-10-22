/**
 * Graduated work goes through the same route as everything else: inbox →
 * sweep → alias, else subject check. No owned entries. Two additions only:
 * the first contribution of an old hub's work item continues that hub, and the
 * sweep queues a note for the work item (the link-back).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { foldRegistry, readLedger } from "./ledger.js";
import { flushWorkLinks, pendingWorkLinks, workIdOfTopic, parseKbNotes } from "./work-links.js";
import type { KbRoots } from "../shared/index.js";

const at = (score: number): number[] => [score, Math.sqrt(1 - score * score), 0];

describe("sweep: graduated work", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const calls: Array<{ step: string; prompt: string }> = [];
  let subjectAnswer: () => unknown;
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
      calls.push({ step, prompt: opts.prompt });
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      if (step === "matchSubject") return schema.parse(subjectAnswer());
      return schema.parse({
        title: "Topic", kind: { type: "fact" }, summary: "s", detail: "## How\n\nd\n\n## History\n\n- 2026-10-22: changed (work-wp-FEAT001).",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  const entry = (id: string, extra = "") =>
    writeFileSync(
      join(entries(), `${id}.md`),
      `---\nid: ${id}\ntitle: Title ${id}\nsummary: Summary of ${id}\nsection: sec-wp-aaaaaa\ncreated: 2025-01-02\n${extra}---\n\nbody\n`
    );
  let n = 0;
  const drop = (topic: string, title = "A title") =>
    writeFileSync(join(inbox(), `${topic.replace(/~/g, "_")}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${(++n).toString(16)}\nprev_hash: null\ndomain_hint: wp\n---\n\n# ${title}\n\nbody ${n}\n`);
  const run = (scores: Record<string, number>) =>
    sweep({
      engine, roots, notify: (m) => notes.push(m),
      getEmbedder: () => ({ embed: async () => [1, 0, 0] }),
      loadEntryVectors: async () => Object.entries(scores).map(([entryId, s]) => ({ entryId, domain: "wp", vector: at(s) })) as any,
    });
  const subjectCalls = () => calls.filter((c) => c.step === "matchSubject");
  const produceCalls = () => calls.filter((c) => c.step === "produce");
  const aliasOf = (topic: string) => [...foldRegistry(readLedger(roots)).values()].find((t) => t.aliases.some((a) => a.denTopicId === topic))?.entries[0];

  beforeEach(() => {
    notes.length = 0;
    calls.length = 0;
    n = 0;
    subjectAnswer = () => ({ match: "new" });
    base = mkdtempSync(join(tmpdir(), "kb-work-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    entry("kb-wp-AAAAAAA");
    entry("kb-wp-BBBBBBB");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("a graduation contribution goes through the subject check and merges into the entry it names", async () => {
    drop("work-wp-FEAT001", "Sweep pacing");
    subjectAnswer = () => ({ match: "kb-wp-BBBBBBB" });
    expect(await run({ "kb-wp-AAAAAAA": 0.8, "kb-wp-BBBBBBB": 0.75 })).toMatchObject({ created: 0, merged: 1 });
    expect(subjectCalls()).toHaveLength(1);
    expect(produceCalls()[0].prompt).toContain("EXISTING ENTRY (kb-wp-BBBBBBB)");
    expect(aliasOf("work-wp-FEAT001")).toBe("kb-wp-BBBBBBB");
    // the History line keeps its work id in the entry
    expect(readFileSync(join(entries(), "kb-wp-BBBBBBB.md"), "utf8")).toContain("(work-wp-FEAT001)");
    expect(existsSync(join(entries(), "kb-wp-FEAT001.md"))).toBe(false); // no owned entry
  });

  it("an entry from an old graduation is not protected: a similar contribution merges into it", async () => {
    entry("kb-wp-GRAD001", "properties:\n  graduation-commits: abc\n");
    drop("work-wp-FEAT002", "Sweep pacing");
    expect(await run({ "kb-wp-GRAD001": 0.95, "kb-wp-AAAAAAA": 0.5 })).toMatchObject({ created: 0, merged: 1 });
    expect(aliasOf("work-wp-FEAT002")).toBe("kb-wp-GRAD001");
  });

  it("the initiative contribution is routed by its alias and merged, not rebuilt", async () => {
    drop("work-wp-INITI01", "Dockerize");
    expect(await run({ "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 1, merged: 0 });
    const hub = aliasOf("work-wp-INITI01")!;
    expect(hub).toMatch(/^kb-wp-/);
    // the next feature's initiative contribution: same topic id
    drop("work-wp-INITI01", "Dockerize");
    calls.length = 0;
    expect(await run({ [hub]: 0.3, "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 0, merged: 1 });
    expect(subjectCalls()).toHaveLength(0);
    expect(produceCalls()[0].prompt).toContain(`EXISTING ENTRY (${hub})`);
  });

  it("old-hub compatibility: the first contribution of work-<d>-<id> continues the entry kb-<d>-<id>, once", async () => {
    entry("kb-wp-OLDHUB1", "kind: overview\n");
    drop("work-wp-OLDHUB1", "Old initiative");
    expect(await run({ "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 0, merged: 1 });
    expect(notes.some((m) => m.includes("old hub of that work item, continued"))).toBe(true);
    expect(produceCalls()[0].prompt).toContain("EXISTING ENTRY (kb-wp-OLDHUB1)");
    expect(aliasOf("work-wp-OLDHUB1")).toBe("kb-wp-OLDHUB1");
    // later contributions follow the alias (no old-hub note again)
    notes.length = 0;
    drop("work-wp-OLDHUB1", "Old initiative");
    expect(await run({ "kb-wp-OLDHUB1": 0.3 })).toMatchObject({ merged: 1 });
    expect(notes.some((m) => m.includes("old hub"))).toBe(false);
    // a split of that work item is NOT the old hub
    drop("work-wp-OLDHUB1~extra", "Something else");
    expect(await run({ "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 1 });
  });

  it("queues a note per committed work contribution, including splits; other topics queue none", async () => {
    drop("work-wp-FEAT003", "One");
    await run({});
    drop("work-wp-FEAT003~second", "Two");
    await run({});
    drop("plain-topic", "Three");
    await run({});
    const links = pendingWorkLinks(roots);
    expect(links.map((l) => [l.workId, l.action])).toEqual([["work-wp-FEAT003", "created"], ["work-wp-FEAT003", "created"]]);
    expect(links[0].entryId).not.toBe(links[1].entryId);
  });
});

describe("work links", () => {
  let dir: string;
  let roots: KbRoots;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-links-"));
    roots = { kbBase: join(dir, "b"), opsRoot: join(dir, "o"), denLocal: join(dir, "d") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const queue = async () => (await import("./work-links.js")).queueWorkLink;

  it("maps den topics to work ids and parses the notes back", () => {
    expect(workIdOfTopic("work-wolfpack-lpCuBt3")).toBe("work-wolfpack-lpCuBt3");
    expect(workIdOfTopic("work-wolfpack-lpCuBt3~sweep-pacing")).toBe("work-wolfpack-lpCuBt3");
    expect(workIdOfTopic("sweep-pacing")).toBeNull();
    expect(parseKbNotes([{ text: "KB: created kb-wp-AAAAAAA" }, { text: "KB: updated kb-wp-BBBBBBB" }, { text: "KB: updated kb-wp-AAAAAAA" }, { text: "Archived on graduation." }]))
      .toEqual({ created: ["kb-wp-AAAAAAA"], updated: ["kb-wp-BBBBBBB", "kb-wp-AAAAAAA"], all: ["kb-wp-AAAAAAA", "kb-wp-BBBBBBB"] });
  });

  it("posts the queued notes; an unreachable Work API leaves them queued and never throws; a deleted item is dropped", async () => {
    const q = await queue();
    q(roots, { workId: "work-wp-AAAAAAA", entryId: "kb-wp-XXXXXXX", action: "created" });
    q(roots, { workId: "work-wp-GONE001", entryId: "kb-wp-YYYYYYY", action: "updated" });
    q(roots, { workId: "work-wp-BBBBBBB", entryId: "kb-wp-ZZZZZZZ", action: "updated" });

    expect(await flushWorkLinks(roots, null)).toEqual({ sent: 0, pending: 3 }); // not configured
    let down = true;
    const sent: string[] = [];
    const post = async (id: string, text: string) => {
      if (down) throw new Error("ECONNREFUSED");
      if (id === "work-wp-GONE001") return "gone" as const;
      sent.push(`${id}: ${text}`);
      return "ok" as const;
    };
    expect(await flushWorkLinks(roots, post, (m) => sent.push(m))).toEqual({ sent: 0, pending: 3 });
    expect(pendingWorkLinks(roots)).toHaveLength(3);
    down = false;
    expect(await flushWorkLinks(roots, post)).toEqual({ sent: 3, pending: 0 });
    expect(sent.filter((s) => s.startsWith("work-"))).toEqual(["work-wp-AAAAAAA: KB: created kb-wp-XXXXXXX", "work-wp-BBBBBBB: KB: updated kb-wp-ZZZZZZZ"]);
    expect(pendingWorkLinks(roots)).toEqual([]);
  });
});
