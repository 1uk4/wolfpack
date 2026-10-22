import { describe, it, expect } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { LlmInfraError } from "@wolfpack/engine";
import {
  consolidateWorkRecords,
  extractRecord,
  renderRecord,
  renderWorkingDocument,
  renderFeatureRecord,
  replaceRecordSection,
  withoutRecord,
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
    expect(prompts[0]).toContain("- old finding");
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

  it("archived and deleted items fall back to the den; so does having no store", async () => {
    const { store } = fakeStore({ arch: { stage: "archived" } });
    const lines: string[] = [];
    const out = await consolidateWorkRecords({ engine: fakeEngine([]), store, observations: [...obs("arch", "x"), ...obs("gone", "y")], onProgress: (m) => lines.push(m) });
    expect(out).toEqual([
      { work: "arch", ids: ["arch-0"], status: "fallback", reason: "archived" },
      { work: "gone", ids: ["gone-0"], status: "fallback", reason: "deleted" },
    ]);
    expect(lines.join("\n")).toContain("archived");
    const none = await consolidateWorkRecords({ engine: fakeEngine([]), observations: obs("a", "x") });
    expect(none[0].status).toBe("fallback");
  });

  it("an over-long answer is asked to fold once, then hard-trimmed to the cap", async () => {
    const { store, writes } = fakeStore({ a: {} });
    const fat = rec({ findings: Array.from({ length: 200 }, (_, i) => `finding ${i} ${"x".repeat(60)}`) });
    const prompts: string[] = [];
    const out = await consolidateWorkRecords({ engine: fakeEngine([fat, fat], prompts), store, observations: obs("a", "x") });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous answer rendered");
    expect(out[0].status).toBe("written");
    expect(extractRecord(writes[0].body)!.length).toBeLessThanOrEqual(RECORD_CAP);
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
