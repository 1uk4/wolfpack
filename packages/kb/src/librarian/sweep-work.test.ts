/**
 * Graduated work goes through the same route as everything else: inbox →
 * sweep → alias, else subject check. No owned entries. Two additions only:
 * an anchored contribution is routed by its key (an old hub is adopted), and the
 * sweep queues a note for the work item (the link-back).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { Entry } from "../schema/knowledge.js";
import { lintKnowledge } from "../shared/knowledgeLint.js";
import { writeEntrySection } from "./reorg.js";
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
  const drop = (topic: string, title = "A title", anchor?: string) =>
    writeFileSync(join(inbox(), `${topic.replace(/~/g, "_")}.md`), `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${(++n).toString(16)}\nprev_hash: null\ndomain_hint: wp\n${anchor ? `anchor: ${anchor}\n` : ""}---\n\n# ${title}\n\nbody ${n}\n`);
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

  describe("graduation provenance", () => {
    const dropSrc = (topic: string, src: string, f: { anchor?: string; verbatim?: boolean } = {}) =>
      writeFileSync(
        join(inbox(), `${topic.replace(/~/g, "_")}-${++n}.md`),
        `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${n.toString(16)}\nprev_hash: null\ndomain_hint: wp\n${f.anchor ? `anchor: ${f.anchor}\n` : ""}${f.verbatim ? "verbatim: true\n" : ""}${src}---\n\n# A rule\n\nbody ${n}\n`
      );
    const props = (md: string) => Object.fromEntries([...md.matchAll(/^  (source-[a-z-]+): "(.*)"$/gm)].map((m) => [m[1], m[2]]));
    // the entry the sweep wrote (the two seeded ones are older)
    const only = () => readFileSync(join(entries(), readdirSync(entries()).find((f) => !f.startsWith("kb-wp-AAAAAAA") && !f.startsWith("kb-wp-BBBBBBB"))!), "utf8");

    it("a produced entry carries source-feature / source-tasks / source-record-lines, and they pass the schema and the lint", async () => {
      dropSrc("work-wp-FEAT001", "source_feature: work-wp-FEAT001\nsource_tasks: work-wp-TASK001, work-wp-TASK002\nsource_record_lines: a1b2c3d4, 0a0b0c0d\n");
      await run({});
      expect(props(only())).toEqual({ "source-feature": "work-wp-FEAT001", "source-tasks": "work-wp-TASK001, work-wp-TASK002", "source-record-lines": "a1b2c3d4, 0a0b0c0d" });
      const properties = Object.fromEntries(Object.entries(props(only())));
      expect(Entry.shape.properties.parse(properties)).toEqual(properties);
      expect(lintKnowledge({ title: "t", summary: "s", body: "b", properties }).filter((f) => f.code === "forbidden-property")).toEqual([]);
    });

    it("a verbatim anchored entry carries them too, and a later graduation to it adds its own", async () => {
      dropSrc("work-wp-FEAT001", "source_feature: work-wp-FEAT001\nsource_record_lines: a1b2c3d4\n", { anchor: "work-wp-FEAT001", verbatim: true });
      await run({});
      expect(props(only())).toEqual({ "source-feature": "work-wp-FEAT001", "source-record-lines": "a1b2c3d4" });
      dropSrc("work-wp-FEAT001", "source_feature: work-wp-FEAT001\nsource_record_lines: a1b2c3d4, 99998888\n", { anchor: "work-wp-FEAT001", verbatim: true });
      await run({});
      expect(props(only())).toEqual({ "source-feature": "work-wp-FEAT001", "source-record-lines": "a1b2c3d4, 99998888" });
    });

    it("a contribution without source leaves the entry's properties alone; unsafe values are dropped at intake", async () => {
      dropSrc("work-wp-FEAT001", "source_feature: not a valid id!\nsource_tasks: ../../x\n");
      await run({});
      expect(only()).not.toContain("source-");
    });
  });

  describe("anchored subjects", () => {
    const hubKey = "work-wp-INITI01";
    const anchoredId = () => readdirSync(entries()).map((f) => f.slice(0, -3)).find((id) => /^anchor: /m.test(readFileSync(join(entries(), `${id}.md`), "utf8")))!;

    it("an anchored contribution with no entry creates one and records the anchor (no subject check, no similarity)", async () => {
      drop(hubKey, "Dockerize", hubKey);
      expect(await run({ "kb-wp-AAAAAAA": 0.9, "kb-wp-BBBBBBB": 0.85 })).toMatchObject({ created: 1, merged: 0 });
      expect(subjectCalls()).toHaveLength(0);
      const id = anchoredId();
      expect(id).toMatch(/^kb-wp-/);
      expect(readFileSync(join(entries(), `${id}.md`), "utf8")).toMatch(new RegExp(`^anchor: ${hubKey}$`, "m"));
      // visible in the registry
      expect(readFileSync(join(base, "base", "domains", "wp", "_registry.md"), "utf8")).toContain(`- anchor: ${hubKey}`);
    });

    it("the next anchored contribution merges by key, whatever the scores, with no subject check", async () => {
      drop(hubKey, "Dockerize", hubKey);
      await run({});
      const id = anchoredId();
      drop(hubKey, "Dockerize", hubKey);
      calls.length = 0;
      // the other entries are the best similarity matches; the key wins anyway
      expect(await run({ [id]: 0.3, "kb-wp-AAAAAAA": 0.99 })).toMatchObject({ created: 0, merged: 1 });
      expect(subjectCalls()).toHaveLength(0);
      expect(produceCalls()[0].prompt).toContain(`EXISTING ENTRY (${id})`);
      expect(anchoredId()).toBe(id);
      expect(readFileSync(join(entries(), `${id}.md`), "utf8")).toMatch(new RegExp(`^anchor: ${hubKey}$`, "m"));
      // the alias follows the entry
      expect(aliasOf(hubKey)).toBe(id);
    });

    it("a non-anchored contribution very similar to an anchored entry never merges into it", async () => {
      drop(hubKey, "Dockerize", hubKey);
      await run({});
      const id = anchoredId();
      // clearly the same by similarity: would have merged by the band
      drop("work-wp-FEAT001", "Dockerize sweep");
      expect(await run({ [id]: 0.99, "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 1, merged: 0 });
      expect(aliasOf("work-wp-FEAT001")).not.toBe(id);
      // uncertain: the subject check is asked, and the anchored entry is not offered
      drop("work-wp-FEAT002", "Dockerize more");
      calls.length = 0;
      subjectAnswer = () => ({ match: "new" });
      await run({ [id]: 0.82, "kb-wp-AAAAAAA": 0.8, "kb-wp-BBBBBBB": 0.7 });
      expect(subjectCalls()).toHaveLength(1);
      expect(subjectCalls()[0].prompt).not.toContain(id);
      expect(subjectCalls()[0].prompt).toContain("kb-wp-AAAAAAA");
    });

    it("old-hub adoption: no entry anchored to work-<d>-<id>, kb-<d>-<id> exists → anchored and merged into", async () => {
      entry("kb-wp-INITI01", "kind: overview\n");
      drop(hubKey, "Old initiative", hubKey);
      expect(await run({ "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 0, merged: 1 });
      expect(notes.some((m) => m.includes("old hub adopted"))).toBe(true);
      expect(subjectCalls()).toHaveLength(0);
      expect(produceCalls()[0].prompt).toContain("EXISTING ENTRY (kb-wp-INITI01)");
      expect(readFileSync(join(entries(), "kb-wp-INITI01.md"), "utf8")).toMatch(new RegExp(`^anchor: ${hubKey}$`, "m"));
      // from now on it is found by key, and kept out of similarity
      notes.length = 0;
      drop(hubKey, "Old initiative", hubKey);
      expect(await run({ "kb-wp-INITI01": 0.3 })).toMatchObject({ merged: 1 });
      expect(notes.some((m) => m.includes("old hub"))).toBe(false);
      // a split of that work item is not the hub; the hub is not adopted for a non-anchored contribution
      drop("work-wp-INITI01~extra", "Something else");
      expect(await run({ "kb-wp-AAAAAAA": 0.3 })).toMatchObject({ created: 1 });
    });

    it("an old hub already anchored to another key is not adopted", async () => {
      entry("kb-wp-INITI01", "anchor: something-else\n");
      drop(hubKey, "Old initiative", hubKey);
      expect(await run({})).toMatchObject({ created: 1, merged: 0 });
    });

    it("the anchor survives a reorg's section rewrite and a lost ledger", async () => {
      drop(hubKey, "Dockerize", hubKey);
      await run({});
      const id = anchoredId();
      writeEntrySection(entries(), id, "sec-wp-zzzzzz");
      expect(readFileSync(join(entries(), `${id}.md`), "utf8")).toMatch(new RegExp(`^anchor: ${hubKey}$`, "m"));
      // rebuild: the ledger (den-local) is gone; the key is read from the entry
      rmSync(join(roots.opsRoot, "ledger"), { recursive: true, force: true });
      drop(hubKey, "Dockerize", hubKey);
      calls.length = 0;
      expect(await run({ [id]: 0.3 })).toMatchObject({ created: 0, merged: 1 });
      expect(produceCalls()[0].prompt).toContain(`EXISTING ENTRY (${id})`);
    });

    it("alias routing into an entry that later becomes anchored still works", async () => {
      drop("work-wp-FEAT001", "Sweep pacing");
      subjectAnswer = () => ({ match: "kb-wp-BBBBBBB" });
      await run({ "kb-wp-AAAAAAA": 0.8, "kb-wp-BBBBBBB": 0.75 });
      expect(aliasOf("work-wp-FEAT001")).toBe("kb-wp-BBBBBBB");
      // the entry becomes anchored
      const f = join(entries(), "kb-wp-BBBBBBB.md");
      writeFileSync(f, readFileSync(f, "utf8").replace("id: kb-wp-BBBBBBB\n", "id: kb-wp-BBBBBBB\nanchor: some-key\n"));
      drop("work-wp-FEAT001", "Sweep pacing");
      calls.length = 0;
      expect(await run({ "kb-wp-AAAAAAA": 0.99 })).toMatchObject({ created: 0, merged: 1 });
      expect(subjectCalls()).toHaveLength(0);
      expect(produceCalls()[0].prompt).toContain("EXISTING ENTRY (kb-wp-BBBBBBB)");
    });
  });

  describe("standing features: verbatim, grouped entries", () => {
    const holderKey = "work-wp-INITI01";
    const dropV = (topic: string, title: string, bodyText: string, f: { anchor?: string; verbatim?: boolean; group?: string; groupDate?: string; summary?: string } = {}) =>
      writeFileSync(
        join(inbox(), `${topic.replace(/~/g, "_")}-${++n}.md`),
        `---\nfrom: w1\nden_topic_id: ${topic}\ncontent_hash: c0de${n.toString(16)}\nprev_hash: null\ndomain_hint: wp\n` +
          `${f.anchor ? `anchor: ${f.anchor}\n` : ""}${f.verbatim ? "verbatim: true\n" : ""}${f.group ? `group: ${f.group}\n` : ""}${f.groupDate ? `group_date: ${f.groupDate}\n` : ""}` +
          `summary: ${JSON.stringify(f.summary ?? "One paragraph about the period.")}\n---\n\n# ${title}\n\n${bodyText}\n`
      );
    const file = (id: string) => readFileSync(join(entries(), `${id}.md`), "utf8");
    const byAnchor = (key: string) => readdirSync(entries()).map((x) => x.slice(0, -3)).find((id) => new RegExp(`^anchor: ${key}$`, "m").test(file(id)))!;
    const BODY_A = "## Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n### 2026-10-14 first day\n\nDone (work-wp-TASK001, commit abc1234).\n\n## Record\n\n- kept as written";

    it("a verbatim anchored contribution is stored exactly as authored, with no model call", async () => {
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true });
      expect(await run({})).toMatchObject({ created: 1, merged: 0 });
      expect(produceCalls()).toHaveLength(0);
      expect(subjectCalls()).toHaveLength(0);
      const md = file(byAnchor("work-wp-FEATA01"));
      expect(md).toContain("title: \"Period A\"");
      expect(md).toMatch(/^kind: fact$/m);
      expect(md).toContain("One paragraph about the period.");
      expect(md).toContain(BODY_A); // tables, dated headings, ids, hashes: untouched
      expect(md).not.toContain("## Detail");
    });

    it("a later verbatim contribution to the same anchor replaces the whole text and keeps id, creation date and group", async () => {
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({});
      const id = byAnchor("work-wp-FEATA01");
      writeFileSync(join(entries(), `${id}.md`), file(id).replace(/^created: .*$/m, "created: 2026-01-01"));
      dropV("work-wp-FEATA01", "Period A", "## Plan\n\nrewritten entirely", { anchor: "work-wp-FEATA01", verbatim: true });
      expect(await run({ [id]: 0.3 })).toMatchObject({ created: 0, merged: 1 });
      expect(produceCalls()).toHaveLength(0);
      expect(byAnchor("work-wp-FEATA01")).toBe(id);
      const md = file(id);
      expect(md).toContain("rewritten entirely");
      expect(md).not.toContain("kept as written");
      expect(md).toMatch(/^created: 2026-01-01$/m);
      expect(md).toMatch(new RegExp(`^group: ${holderKey}$`, "m"));
      expect(md).toMatch(/^groupDate: 2026-10-14$/m);
    });

    it("an identical verbatim re-send changes nothing: no rewrite, no new version", async () => {
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({});
      const id = byAnchor("work-wp-FEATA01");
      const before = file(id);
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({ [id]: 0.3 });
      expect(file(id)).toBe(before);
      expect(existsSync(join(base, "base", "domains", "wp", "versions", id))).toBe(false);
    });

    it("a feature swept before its holder ends up in the holder's section", async () => {
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({});
      dropV(holderKey, "The initiative", "body", { anchor: holderKey });
      await run({});
      const holder = byAnchor(holderKey);
      const hs = file(holder).match(/^section: (\S+)$/m)![1];
      expect(file(byAnchor("work-wp-FEATA01"))).toMatch(new RegExp(`^section: ${hs}$`, "m"));
    });

    it("a verbatim entry is skipped by the size guard and left out of every other contribution's candidates", async () => {
      process.env.KB_MAX_MERGE_TARGET_CHARS = "100";
      try {
        dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true });
        await run({});
        const id = byAnchor("work-wp-FEATA01");
        dropV("work-wp-FEATA01", "Period A", `${BODY_A}\n\nmore`, { anchor: "work-wp-FEATA01", verbatim: true });
        expect(await run({ [id]: 0.3 })).toMatchObject({ created: 0, merged: 1 }); // replaced in place despite its size
        dropV("work-wp-OTHER01", "Period A again", "text");
        expect(await run({ [id]: 0.99 })).toMatchObject({ created: 1, merged: 0 });
        expect(aliasOf("work-wp-OTHER01")).not.toBe(id);
      } finally {
        delete process.env.KB_MAX_MERGE_TARGET_CHARS;
      }
    });

    it("a grouped entry takes its holder's section", async () => {
      dropV(holderKey, "The initiative", "body", { anchor: holderKey });
      await run({});
      const holder = byAnchor(holderKey);
      writeEntrySection(entries(), holder, "sec-wp-hhhhhh");
      dropV("work-wp-FEATA01", "Period A", BODY_A, { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({ [holder]: 0.3 });
      const md = file(byAnchor("work-wp-FEATA01"));
      expect(md).toMatch(/^section: sec-wp-hhhhhh$/m);
      expect(md).toMatch(/^placement:\n  basis: routed\n  fit: 1.000$/m);
    });

    const deliveredLines = (id: string) => file(id).split("\n").filter((l) => l.startsWith("- Period"));

    it("the holder's Delivered list follows its group in date order: members swept after the holder", async () => {
      dropV(holderKey, "The initiative", "body", { anchor: holderKey });
      await run({});
      dropV("work-wp-FEATB01", "Period B", "b", { anchor: "work-wp-FEATB01", verbatim: true, group: holderKey, groupDate: "2026-10-20" });
      await run({});
      dropV("work-wp-FEATA01", "Period A", "a", { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({});
      const idA = byAnchor("work-wp-FEATA01");
      const idB = byAnchor("work-wp-FEATB01");
      expect(deliveredLines(byAnchor(holderKey))).toEqual([`- Period A: [[${idA}]]`, `- Period B: [[${idB}]]`]);
      // content hash tracks the new text
      expect(file(byAnchor(holderKey))).toMatch(/^contentHash: sha256:[0-9a-f]{64}$/m);
    });

    it("the holder's Delivered list follows its group in date order: members swept before the holder", async () => {
      dropV("work-wp-FEATB01", "Period B", "b", { anchor: "work-wp-FEATB01", verbatim: true, group: holderKey, groupDate: "2026-10-20" });
      await run({});
      dropV("work-wp-FEATA01", "Period A", "a", { anchor: "work-wp-FEATA01", verbatim: true, group: holderKey, groupDate: "2026-10-14" });
      await run({});
      dropV(holderKey, "The initiative", "body", { anchor: holderKey });
      await run({});
      const idA = byAnchor("work-wp-FEATA01");
      const idB = byAnchor("work-wp-FEATB01");
      expect(deliveredLines(byAnchor(holderKey))).toEqual([`- Period A: [[${idA}]]`, `- Period B: [[${idB}]]`]);
      // a re-sweep of the holder changes nothing further
      dropV(holderKey, "The initiative", "body changed", { anchor: holderKey });
      await run({});
      expect(deliveredLines(byAnchor(holderKey))).toEqual([`- Period A: [[${idA}]]`, `- Period B: [[${idB}]]`]);
    });
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
