import { describe, it, expect } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { LlmInfraError } from "@wolfpack/engine";
import { stripSources, parseRecordLines, formatSources } from "./record-sources.js";
import {
  consolidateWorkRecords,
  extractRecord,
  renderRecord,
  renderWorkingDocument,
  renderFeatureRecord,
  replaceRecordSection,
  withoutRecord,
  resolveSources,
  recordLines,
  findRecordLine,
  RECORD_CAP,
  DOCUMENT_CAP,
  type WorkRecord,
  type WorkRecordItem,
  type WorkRecordStore,
} from "./work-record.js";

const REC = "## Record\n\n### Decisions\n\n- Use X — why: Y";

const PLAN = [
  "## Plan",
  "",
  "Do the thing.",
  "",
  "### Record keeping",
  "",
  "This H3 mentions Record but is not the section.",
  "",
  "## Records of the old system",
  "",
  "Not the section either.",
  "",
  "```md",
  "## Record",
  "not a heading: inside a fence",
  "```",
  "",
  "## Notes",
  "",
  "keep   me  exactly\t as is",
].join("\n");

describe("replaceRecordSection", () => {
  it("appends the section at the end when the document has none, plan untouched", () => {
    const out = replaceRecordSection(PLAN, REC);
    expect(out.startsWith(PLAN)).toBe(true);
    expect(out).toBe(`${PLAN}\n\n${REC}\n`);
    expect(extractRecord(out)).toBe(REC);
  });

  it("ignores look-alike headings and fenced '## Record' lines", () => {
    expect(extractRecord(PLAN)).toBeNull();
    expect(withoutRecord(PLAN)).toBe(PLAN);
  });

  it("replaces only the Record section, byte for byte elsewhere", () => {
    const doc = `${PLAN}\n\n## Record\n\n- old one\n- old two\n\n## After\n\nafter text  \n`;
    const out = replaceRecordSection(doc, REC);
    const start = doc.indexOf("## Record\n\n- old");
    const after = doc.indexOf("## After");
    expect(out.slice(0, start)).toBe(doc.slice(0, start));
    expect(out.slice(out.indexOf("## After"))).toBe(doc.slice(after));
    expect(out).toContain(REC);
    expect(out).not.toContain("old one");
    // the look-alikes survived
    expect(out).toContain("### Record keeping");
    expect(out).toContain("```md\n## Record\nnot a heading: inside a fence\n```");
  });

  it("is idempotent", () => {
    const once = replaceRecordSection(`${PLAN}\n\n## Record\n\n- old\n\n## After\n\nx`, REC);
    expect(replaceRecordSection(once, REC)).toBe(once);
  });

  it("works on an empty document and on a Record that is the whole document", () => {
    expect(replaceRecordSection("", REC)).toBe(`${REC}\n`);
    expect(replaceRecordSection(`${REC}\n`, "## Record\n\n- new")).toBe("## Record\n\n- new\n");
  });

  it("keeps the Record's own H3 subsections inside the section", () => {
    const doc = `intro\n\n${renderRecord({ decisions: [{ decision: "a", why: "b" }], changes: ["c"], findings: [], problems: [] })}\n\n## Tail\n\nt`;
    expect(extractRecord(doc)).toContain("### Changes");
    expect(extractRecord(doc)).not.toContain("Tail");
  });
});

describe("renderRecord", () => {
  it("fixed order, empty groups left out, one-line bullets", () => {
    const out = renderRecord({
      decisions: [{ decision: "Use A", why: "B is\nslow" }],
      changes: [],
      findings: ["F"],
      problems: ["P → fix"],
    });
    expect(out).toBe("## Record\n\n### Decisions\n\n- Use A — why: B is slow\n\n### Findings\n\n- F\n\n### Problems & fixes\n\n- P → fix");
  });
});

describe("renderWorkingDocument", () => {
  const record = `## Record\n\n### Findings\n\n${Array.from({ length: 40 }, (_, i) => `- finding number ${i} with some words`).join("\n")}`;

  it("passes a small document through", () => {
    const doc = `## Plan\n\nship it\n\n${REC}`;
    expect(renderWorkingDocument(doc)).toBe(doc);
  });

  it("is capped and keeps the Record when the plan is long", () => {
    const doc = `## Plan\n\n${"plan line\n".repeat(900)}\n${record}`;
    const out = renderWorkingDocument(doc);
    expect(out.length).toBeLessThanOrEqual(DOCUMENT_CAP);
    expect(out).toContain("## Plan");
    expect(out).toContain("finding number 39"); // Record intact
    expect(out).toContain("[…]"); // plan clipped
  });

  it("clips the Record last, still leaving the plan a start", () => {
    const big = `## Record\n\n${"- long record bullet text\n".repeat(400)}`;
    const out = renderWorkingDocument(`## Plan\n\nthe plan\n\n${big}`);
    expect(out.length).toBeLessThanOrEqual(DOCUMENT_CAP);
    expect(out).toContain("the plan");
    expect(out).toContain("## Record");
  });
});

// ── consolidateWorkRecords ───────────────────────────────────────────────────

function fakeStore(items: Record<string, Partial<WorkRecordItem>>, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const writes: Array<{ id: string; body: string }> = [];
  const store: WorkRecordStore = {
    async get(id) {
      if (opts.failGet) throw new Error("Work API unreachable");
      const it = items[id];
      return it ? { id, title: "T", kind: "task", stage: "in_build", body: "", ...it } : null;
    },
    async setBody(id, body) {
      if (opts.failSet) throw new Error("HTTP 502");
      writes.push({ id, body });
      items[id] = { ...items[id], body };
    },
  };
  return { store, writes };
}

const rec = (over: Partial<WorkRecord> = {}): WorkRecord => ({ decisions: [], changes: [], findings: [], problems: [], ...over });

function fakeEngine(answers: Array<WorkRecord | Error>, prompts: string[] = []) {
  return {
    call: async (_step: string, _schema: unknown, o: { prompt: string }) => {
      prompts.push(o.prompt);
      const a = answers.shift();
      if (!a) throw new Error("no more answers");
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as Engine;
}

const obs = (work: string, ...contents: string[]) => contents.map((c, i) => ({ id: `${work}-${i}`, content: c, work }));

describe("consolidateWorkRecords", () => {
  it("writes the Record from the plan + current Record + new observations, replacing only that section", async () => {
    const { store, writes } = fakeStore({ "work-a": { title: "Fix cache", successCriteria: "no stale reads", body: `## Plan\n\nstep one\n\n## Record\n\n### Findings\n\n- old finding\n\n## Notes\n\nn` } });
    const prompts: string[] = [];
    const engine = fakeEngine([rec({ decisions: [{ decision: "Use TTL", why: "simplest" }], findings: ["old finding"] })], prompts);
    const out = await consolidateWorkRecords({ engine, store, observations: obs("work-a", "chose a TTL cache because invalidation is hard") });

    expect(out).toEqual([{ work: "work-a", ids: ["work-a-0"], status: "written", chars: expect.any(Number) }]);
    expect(prompts[0]).toContain("Fix cache");
    expect(prompts[0]).toContain("no stale reads");
    expect(prompts[0]).toContain("step one");
    expect(prompts[0]).toContain("- [r1] old finding");
    expect(prompts[0]).toContain("chose a TTL cache");
    expect(writes).toHaveLength(1);
    expect(writes[0].body.startsWith("## Plan\n\nstep one\n\n## Record")).toBe(true);
    expect(writes[0].body).toContain("- Use TTL — why: simplest");
    expect(writes[0].body.endsWith("## Notes\n\nn")).toBe(true);
  });

  it("groups by work id: one rewrite per item", async () => {
    const { store, writes } = fakeStore({ a: {}, b: {} });
    const engine = fakeEngine([rec({ findings: ["fa"] }), rec({ findings: ["fb"] })]);
    const out = await consolidateWorkRecords({ engine, store, observations: [...obs("a", "x", "y"), ...obs("b", "z")] });
    expect(out.map((o) => `${o.work}:${o.status}`)).toEqual(["a:written", "b:written"]);
    expect(writes.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("an infra error leaves the observations pending and writes nothing", async () => {
    const { store, writes } = fakeStore({ a: {} });
    const engine = fakeEngine([new LlmInfraError("overloaded")]);
    const out = await consolidateWorkRecords({ engine, store, observations: obs("a", "x") });
    expect(out[0].status).toBe("pending");
    expect(writes).toEqual([]);
  });

  it("a Work API failure (read or write) leaves them pending", async () => {
    for (const opts of [{ failGet: true }, { failSet: true }]) {
      const { store } = fakeStore({ a: {} }, opts);
      const out = await consolidateWorkRecords({ engine: fakeEngine([rec({ findings: ["f"] })]), store, observations: obs("a", "x") });
      expect(out[0].status).toBe("pending");
    }
  });

  it("archived and deleted items are discarded; having no store leaves them pending", async () => {
    const { store } = fakeStore({ arch: { stage: "archived" } });
    const lines: string[] = [];
    const out = await consolidateWorkRecords({ engine: fakeEngine([]), store, observations: [...obs("arch", "x"), ...obs("gone", "y")], onProgress: (m) => lines.push(m) });
    expect(out).toEqual([
      { work: "arch", ids: ["arch-0"], status: "discarded", reason: "archived" },
      { work: "gone", ids: ["gone-0"], status: "discarded", reason: "deleted" },
    ]);
    expect(lines.join("\n")).toContain("archived");
    const none = await consolidateWorkRecords({ engine: fakeEngine([]), observations: obs("a", "x") });
    expect(none[0]).toMatchObject({ status: "pending", reason: "work-api-unavailable" });
  });

  it("an over-long answer is asked to fold once, then hard-trimmed to the cap", async () => {
    const { store, writes } = fakeStore({ a: {} });
    const fat = rec({ findings: Array.from({ length: 200 }, (_, i) => `finding ${i} ${"x".repeat(60)}`) });
    const prompts: string[] = [];
    const out = await consolidateWorkRecords({ engine: fakeEngine([fat, fat], prompts), store, observations: obs("a", "x") });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous answer rendered");
    expect(out[0].status).toBe("written");
    expect(stripSources(extractRecord(writes[0].body)!).length).toBeLessThanOrEqual(RECORD_CAP);
  });
});

describe("Record per feature", () => {
  const withFeature = (feature: string | undefined, work: string, ...contents: string[]) =>
    contents.map((c, i) => ({ id: `${work}-${i}`, content: c, work, ...(feature ? { feature } : {}) }));

  it("two tasks of one feature fold into ONE Record on the feature", async () => {
    const { store, writes } = fakeStore({ f1: { kind: "feature", title: "The feature" }, t1: {}, t2: {} });
    const prompts: string[] = [];
    const out = await consolidateWorkRecords({
      engine: fakeEngine([rec({ findings: ["shared"] })], prompts),
      store,
      observations: [...withFeature("f1", "t1", "from task one"), ...withFeature("f1", "t2", "from task two")],
    });
    expect(out).toEqual([{ work: "f1", ids: ["t1-0", "t2-0"], status: "written", chars: expect.any(Number) }]);
    expect(writes.map((w) => w.id)).toEqual(["f1"]);
    expect(prompts[0]).toContain("The feature");
    expect(prompts[0]).toContain("from task one");
    expect(prompts[0]).toContain("from task two");
  });

  it("observations while bound to the FEATURE itself (work = feature = its id) go to the feature's Record", async () => {
    const { store, writes } = fakeStore({ f1: { kind: "feature", title: "The feature" } });
    const out = await consolidateWorkRecords({
      engine: fakeEngine([rec({ decisions: [{ decision: "rename X", why: "clearer" }] })]),
      store,
      observations: withFeature("f1", "f1", "follow-up: decided to rename X"),
    });
    expect(out.map((o) => [o.work, o.status])).toEqual([["f1", "written"]]);
    expect(writes.map((w) => w.id)).toEqual(["f1"]);
  });

  it("an Inbox task (feature is a container) keeps its own Record", async () => {
    const { store, writes } = fakeStore({ inbox: { kind: "feature", container: true }, t3: {} });
    const out = await consolidateWorkRecords({ engine: fakeEngine([rec({ findings: ["x"] })]), store, observations: withFeature("inbox", "t3", "inbox work") });
    expect(out.map((o) => o.work)).toEqual(["t3"]);
    expect(writes.map((w) => w.id)).toEqual(["t3"]);
  });

  it("pending lines with only `work` group on the item", async () => {
    const { store, writes } = fakeStore({ t1: {}, t2: {} });
    const out = await consolidateWorkRecords({ engine: fakeEngine([rec({ findings: ["a"] }), rec({ findings: ["b"] })]), store, observations: [...obs("t1", "x"), ...obs("t2", "y")] });
    expect(out.map((o) => o.work)).toEqual(["t1", "t2"]);
    expect(writes.map((w) => w.id)).toEqual(["t1", "t2"]);
  });

  it("a deleted, archived or unreadable feature falls back to the item's own Record", async () => {
    for (const items of [{ t: {} }, { f: { kind: "feature", stage: "archived" }, t: {} }]) {
      const { store, writes } = fakeStore(items as Record<string, Partial<WorkRecordItem>>);
      const out = await consolidateWorkRecords({ engine: fakeEngine([rec({ findings: ["a"] })]), store, observations: withFeature("f", "t", "x") });
      expect(out[0].work).toBe("t");
      expect(writes.map((w) => w.id)).toEqual(["t"]);
    }
    const { store } = fakeStore({ f: { kind: "feature" }, t: {} }, { failGet: true });
    const out = await consolidateWorkRecords({ engine: fakeEngine([]), store, observations: withFeature("f", "t", "x") });
    expect(out[0]).toMatchObject({ work: "t", status: "pending" });
  });

  it("a Record already on a task is left alone", async () => {
    const { store, writes } = fakeStore({ f1: { kind: "feature" }, t1: { body: "## Plan\n\np\n\n## Record\n\n- old" } });
    await consolidateWorkRecords({ engine: fakeEngine([rec({ findings: ["n"] })]), store, observations: withFeature("f1", "t1", "x") });
    expect(writes.map((w) => w.id)).toEqual(["f1"]);
  });
});

describe("renderFeatureRecord", () => {
  it("names the feature, drops the Record heading, and is capped", () => {
    const out = renderFeatureRecord("Big feature", `## Plan\n\np\n\n${REC}\n`);
    expect(out.startsWith("## Feature Record — Big feature")).toBe(true);
    expect(out).toContain("- Use X — why: Y");
    expect(out).not.toContain("## Record");
    const huge = renderFeatureRecord("F", `## Record\n\n${"- long bullet text\n".repeat(500)}`, 1000);
    expect(huge.length).toBeLessThanOrEqual(1000);
    expect(huge.endsWith("[…]")).toBe(true);
  });
  it("is empty when the feature has no Record", () => {
    expect(renderFeatureRecord("F", "## Plan\n\nx")).toBe("");
    expect(renderFeatureRecord("F", "")).toBe("");
  });
});

// ── sources: where each Record line came from ────────────────────────────────

describe("Record line sources", () => {
  const tsObs = (work: string, ...contents: string[]): Array<{ id: string; timestamp?: string; content: string; work: string }> => contents.map((c, i) => ({ id: `id${i + 1}`, timestamp: `2026-10-27T10:0${i}:00Z`, content: c, work }));
  const run = async (answer: unknown, body = "", observations: Array<{ id: string; timestamp?: string; content: string; work: string }> = tsObs("work-a", "first", "second", "third"), prompts: string[] = []) => {
    const { store, writes } = fakeStore({ "work-a": { body } });
    const engine = fakeEngine([answer as WorkRecord], prompts);
    const out = await consolidateWorkRecords({ engine, store, observations });
    expect(out[0].status).toBe("written");
    return { body: writes[0].body, lines: parseRecordLines(extractRecord(writes[0].body)!), prompts };
  };

  it("a line the model mapped carries only its observations, with timestamps (per line)", async () => {
    const { body, lines, prompts } = await run({
      decisions: [{ decision: "Use TTL", why: "simple", from: ["o2"] }],
      changes: [{ text: "Added cache", from: ["o1", "o3"] }],
      findings: [],
      problems: [],
    });
    expect(prompts[0]).toContain("- [o1] first");
    expect(prompts[0]).toContain("- [o3] third");
    expect(lines.map((l) => [l.text, l.sources, l.batch])).toEqual([
      ["Use TTL — why: simple", [{ id: "id2", timestamp: "2026-10-27T10:01:00Z" }], false],
      ["Added cache", [{ id: "id1", timestamp: "2026-10-27T10:00:00Z" }, { id: "id3", timestamp: "2026-10-27T10:02:00Z" }], false],
    ]);
    expect(body).toContain("- Added cache <!-- src: id1@2026-10-27T10:00:00Z id3@2026-10-27T10:02:00Z -->");
  });

  it("a line without a mapping carries the whole batch, flagged [batch]", async () => {
    const { body, lines } = await run({ decisions: [], changes: ["Added cache", { text: "Dropped refs", from: ["o9"] }], findings: [], problems: [] });
    expect(lines.every((l) => l.batch && l.sources.map((s) => s.id).join() === "id1,id2,id3")).toBe(true);
    expect(body).toContain("<!-- src[batch]: id1@");
  });

  it("an unchanged line keeps its sources; a reworded line unions its refs with the new observations", async () => {
    const first = await run({ decisions: [], changes: [{ text: "Added cache", from: ["o1"] }], findings: [{ text: "TTL is 5m", from: ["o2"] }], problems: [] });
    const second = await run(
      { decisions: [], changes: [{ text: "Added cache", from: [] }], findings: [{ text: "TTL is 10m now", from: ["r2", "o1"] }], problems: [] },
      first.body,
      [{ id: "n1", timestamp: "2026-10-28T09:00:00Z", content: "ttl raised", work: "work-a" }],
    );
    expect(second.prompts[0]).toContain("- [r1] Added cache");
    expect(second.prompts[0]).not.toContain("<!--");
    expect(second.lines.find((l) => l.text === "Added cache")).toMatchObject({ sources: [{ id: "id1" }], batch: false });
    expect(second.lines.find((l) => l.text === "TTL is 10m now")!.sources.map((s) => s.id)).toEqual(["id2", "n1"]);
  });

  it("an older Record without sources still parses and renders; carried lines gain none, new lines get the batch", async () => {
    const old = "## Plan\n\np\n\n## Record\n\n### Findings\n\n- old finding\n";
    expect(parseRecordLines(extractRecord(old)!)).toEqual([expect.objectContaining({ group: "Findings", text: "old finding", sources: [], batch: false })]);
    expect(renderFeatureRecord("F", old)).toContain("- old finding");
    const { body, lines } = await run({ decisions: [], changes: ["new thing"], findings: [{ text: "old finding", from: ["r1"] }], problems: [] }, old);
    expect(lines.find((l) => l.text === "old finding")!.sources).toEqual([]);
    expect(body).toContain("- old finding\n");
    expect(lines.find((l) => l.text === "new thing")!.batch).toBe(true);
  });

  it("the agent's views and the size cap leave the comments out; the document keeps them", async () => {
    const { body } = await run({ decisions: [], changes: [{ text: "Added cache", from: ["o1"] }], findings: [], problems: [] });
    expect(body).toContain("<!--");
    expect(renderFeatureRecord("F", body)).not.toContain("<!--");
    expect(renderFeatureRecord("F", body)).toContain("- Added cache");
    expect(renderWorkingDocument(body)).not.toContain("<!--");
    expect(stripSources(body)).toContain("- Added cache\n");
  });

  it("a reworded line with no rN keeps the sources of the line it replaced, plus the new batch (flagged)", async () => {
    const first = await run({ decisions: [], changes: [], findings: [{ text: "The TTL cache expires entries after five minutes", from: ["o2"] }], problems: [] });
    const second = await run(
      { decisions: [], changes: [], findings: ["The TTL cache expires entries after ten minutes now"], problems: [] },
      first.body,
      [{ id: "n1", timestamp: "2026-10-28T09:00:00Z", content: "ttl raised", work: "work-a" }],
    );
    expect(second.lines[0].sources.map((s) => s.id)).toEqual(["id2", "n1"]);
    expect(second.lines[0].batch).toBe(true);
    // an unrelated new line gets only the batch
    const third = await run({ decisions: [], changes: [], findings: ["Something unrelated entirely", "The TTL cache expires entries after five minutes"], problems: [] }, first.body, [{ id: "n2", content: "x", work: "work-a" }]);
    expect(third.lines.find((l) => l.text.startsWith("Something"))!.sources.map((s) => s.id)).toEqual(["n2"]);
    expect(third.lines.find((l) => l.text.startsWith("The TTL"))!.batch).toBe(false);
  });

  it("past SOURCE_CAP the comment says +Nmore, and the count survives the next rewrite", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${String(i).padStart(2, "0")}`, timestamp: `t${i}`, content: `c${i}`, work: "work-a" }));
    const first = await run({ decisions: [], changes: ["A line"], findings: [], problems: [] }, "", many);
    expect(first.body).toMatch(/<!-- src\[batch\]: (id\d+@t\d+ ){23}id29@t29 \+6more -->/);
    expect(first.lines[0]).toMatchObject({ more: 6 });
    expect(first.lines[0].sources).toHaveLength(24);
    const again = await run({ decisions: [], changes: [{ text: "A line", from: ["r1"] }], findings: [], problems: [] }, first.body, [{ id: "z", content: "z", work: "work-a" }]);
    expect(again.lines[0].more).toBe(6);
  });

  it("comment delimiters in model text are removed before the line is written", async () => {
    const { body, lines } = await run({ decisions: [], changes: ["Added cache --> x <!-- src: evil@now"], findings: [], problems: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Added cache x src: evil@now");
    expect(lines[0].sources.map((s) => s.id)).toEqual(["id1", "id2", "id3"]); // the real ones, not "evil"
    expect(body.match(/<!--/g)).toHaveLength(1);
  });

  it("accepts the model's null/absent `from` and bare strings", async () => {
    const { WorkRecordSchema } = await import("./work-record.js");
    const r = WorkRecordSchema.parse({ decisions: [{ decision: "d", why: "w", from: null }], changes: ["c"], findings: [{ text: "f" }], problems: [] });
    expect(r.decisions[0].from).toEqual([]);
    expect(findRecordLine("## Record\n\n### Changes\n\n- c\n", parseRecordLines("### Changes\n\n- c")[0].ref)?.text).toBe("c");
  });
});
