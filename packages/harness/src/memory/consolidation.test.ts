import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic } from "@wolfpack/memory";
import { consolidatePool, durableSessionTopics } from "./consolidation.js";

const WOLF = "w1";
let root: string;
let den: string;
let roots: KbRoots;

function receipt(id: string, body: string): void {
  const dir = join(roots.opsRoot, "receipts", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-${contentHash(body).slice(7, 17)}.md`),
    `---\nfrom: ${WOLF}\nden_topic_id: ${id}\noutcome: merge\nprocessed: 2026-10-20 18:00\n---\n\nkb-wolfpack-AAAAAAA\n`,
  );
}

function pool(n: number): void {
  const dir = join(den, ".memory", "pool");
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({ timestamp: `2026-10-20T10:0${i}:00Z`, content: `observation ${i} `.repeat(60) }),
  );
  writeFileSync(join(dir, "observations.jsonl"), lines.join("\n") + "\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "consolidate-pool-"));
  den = join(root, "den");
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(den, "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("consolidatePool reconcile (pi-durable promote)", () => {
  it("archives absorbed den topics before the LLM sees the den", async () => {
    writeDenTopic(den, { id: "absorbed", title: "Absorbed", summary: "s", updated: "x", body: "absorbed body" });
    receipt("absorbed", "absorbed body");
    writeDenTopic(den, { id: "pending", title: "Pending", summary: "s", updated: "x", body: "pending body" });
    pool(6);

    let prompt = "";
    const engine = {
      call: async (_step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) => {
        prompt = opts.prompt;
        return schema.parse({ actions: [] });
      },
    } as unknown as Engine;

    const progress: string[] = [];
    await consolidatePool({ wolfDen: den, wolfName: WOLF, kbRoots: roots, skipClaims: true, engine, onProgress: (m) => progress.push(m) });

    expect(progress).toContain("reconciled: 1 archived, 1 pending");
    expect(readdirSync(join(den, "memory", "archive"))).toEqual(["absorbed.md"]);
    expect(prompt).toContain("pending body");
    expect(prompt).not.toContain("absorbed body");
  });

  it("keeps only subscribed domains as the hint; invented tags fall back to the default", async () => {
    pool(6);
    const engine = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { prompt: string }) =>
        step === "distill"
          ? schema.parse({ contributions: [{ slug: "main", title: /^TOPIC TITLE: (.*)$/m.exec(opts.prompt)?.[1] ?? "Topic", summary: "s", body: "## Details\nbody" }] })
          : schema.parse({ actions: [
          { sessionTopicId: "lift", action: "create", reasoning: "r", result: { id: "lift", title: "Lift", summary: "s", body: "b1", domain: "fitness" } },
          { sessionTopicId: "plan", action: "create", reasoning: "r", result: { id: "plan", title: "Plan", summary: "s", body: "b2", domain: "personal" } },
        ] }),
    } as unknown as Engine;

    await consolidatePool({ wolfDen: den, wolfName: WOLF, kbRoots: roots, defaultDomain: "personal", domains: ["personal"], engine });

    const inbox = join(roots.opsRoot, "inbox", WOLF);
    const hints = readdirSync(inbox).map((f) => /domain_hint: (\S+)/.exec(readFileSync(join(inbox, f), "utf8"))?.[1]);
    expect(hints).toEqual(["personal", "personal"]);
    expect(readFileSync(join(den, "memory", "topics", "lift.md"), "utf8")).toContain("domain: personal");
  });
});


describe("consolidatePool work-tagged observations (pi-durable)", () => {
  function poolWith(lines: object[]): void {
    const dir = join(den, ".memory", "pool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "observations.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  const o = (n: number, extra: object = {}) => ({ timestamp: `2026-10-20T10:0${n}:00Z`, recordedAt: `2026-10-20T11:0${n}:00Z`, content: `observation ${n}`, ...extra });
  const poolLines = () => readFileSync(join(den, ".memory", "pool", "observations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  function mocks(opts: { failSet?: boolean } = {}) {
    const prompts = { consolidate: [] as string[], record: [] as string[] };
    const writes: Array<{ id: string; body: string }> = [];
    const engine = {
      call: async (step: string, schema: { parse: (v: unknown) => unknown }, p: { prompt: string }) => {
        if (step === "workRecord") {
          prompts.record.push(p.prompt);
          return schema.parse({ decisions: [], changes: ["Added the thing"], findings: [], problems: [] });
        }
        prompts.consolidate.push(p.prompt);
        return schema.parse({ actions: [] });
      },
    } as unknown as Engine;
    const workStore = {
      get: async (id: string) => (id === "gone" ? null : { id, title: "T", kind: "task", stage: "in_build", body: "## Plan\n\np" }),
      setBody: async (id: string, body: string) => {
        if (opts.failSet) throw new Error("HTTP 502");
        writes.push({ id, body });
      },
    };
    return { engine, workStore, prompts, writes };
  }

  it("writes the Record, keeps tagged content out of the den prompt and off the pool", async () => {
    poolWith([o(0), o(1, { work: "work-t1", feature: "work-f1" }), o(2), o(3), o(4), o(5)]);
    const m = mocks();
    const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });

    expect(r.recordsWritten).toBe(1);
    expect(m.prompts.record[0]).toContain("observation 1");
    expect(m.prompts.consolidate[0]).not.toContain("observation 1");
    expect(m.prompts.consolidate[0]).toContain("observation 2");
    expect(m.writes[0].body).toContain("## Record\n\n### Changes\n\n- Added the thing");
    expect(m.writes[0].body.startsWith("## Plan\n\np")).toBe(true);
    expect(poolLines()).toEqual([]);
  });

  it("an infra failure leaves only the tagged observations in the pool", async () => {
    poolWith([o(0), o(1, { work: "work-t1" }), o(2), o(3), o(4), o(5)]);
    const m = mocks({ failSet: true });
    const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });

    expect(r.observationsPending).toBe(1);
    expect(poolLines().map((l) => l.content)).toEqual(["observation 1"]);
    expect(readdirSync(join(den, ".memory", "archive"))).toHaveLength(1);
  });

  it("tagged observations for a deleted item are discarded and logged, never the den; few tagged observations still get their Record", async () => {
    poolWith([o(0, { work: "gone" }), o(1, { work: "work-t1" })]);
    const m = mocks();
    const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(r.recordsWritten).toBe(1);
    expect(m.writes.map((w) => w.id)).toEqual(["work-t1"]);
    // a 404 is not trusted yet: grace period, the observation waits and nothing is logged
    expect(poolLines().map((l) => l.content)).toEqual(["observation 0"]);
    expect(existsSync(join(den, ".memory", "pool", "discarded.jsonl"))).toBe(false);
    await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(poolLines()).toEqual([]);
    expect(m.prompts.consolidate).toEqual([]);
    const logged = readFileSync(join(den, ".memory", "pool", "discarded.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ content: "observation 0", work: "gone", reason: "deleted" });
  });

  it("a feature-only observation never reaches the den, even without a work tag", async () => {
    poolWith([o(0, { feature: "work-f1" }), o(1), o(2), o(3), o(4), o(5)]);
    const m = mocks();
    await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(m.prompts.consolidate.join("\n")).not.toContain("observation 0");
    expect(m.writes.map((w) => w.id)).toEqual(["work-f1"]);
    expect(poolLines()).toEqual([]);
  });

  it("untagged observations still consolidate while a tagged group is pending (no starvation), and the tagged retry backs off", async () => {
    poolWith([o(0, { work: "work-t1" }), o(1), o(2), o(3), o(4), o(5)]);
    const m = mocks({ failSet: true });
    let sets = 0;
    const setBody = m.workStore.setBody;
    m.workStore.setBody = async (id: string, b: string) => { sets++; return setBody(id, b); };
    const cfg = { wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore, poolTarget: 1 };
    const r = await consolidatePool(cfg);
    expect(r.observationsPending).toBe(1);
    expect(m.prompts.consolidate.join("\n")).toContain("observation 1");
    expect(poolLines().map((l) => l.content)).toEqual(["observation 0"]);
    expect(sets).toBe(1);
    await consolidatePool(cfg);
    expect(sets).toBe(1); // backing off: not retried on every trigger
  });

  it("a 404 is only trusted while the Work API is healthy; an unhealthy API keeps them pending", async () => {
    poolWith([o(0, { work: "gone" })]);
    const m = mocks();
    const store = Object.assign(m.workStore, { healthy: async () => false });
    const cfg = { wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: store };
    await consolidatePool(cfg);
    await consolidatePool(cfg);
    await consolidatePool(cfg);
    expect(poolLines()).toHaveLength(1);
    expect(existsSync(join(den, ".memory", "pool", "discarded.jsonl"))).toBe(false);
  });

  it("a task of a live feature that shipped or was archived is written to the feature's Record, not discarded", async () => {
    poolWith([o(1, { work: "work-t1", feature: "work-f1" }), o(2, { work: "work-t2", feature: "work-f1" })]);
    const m = mocks();
    const get = m.workStore.get;
    m.workStore.get = async (id: string) =>
      id === "work-f1" ? { id, title: "F", kind: "feature", stage: "in_build", body: "" }
      : id === "work-t1" ? { id, title: "T1", kind: "task", stage: "shipped", body: "" }
      : id === "work-t2" ? { id, title: "T2", kind: "task", stage: "archived", body: "" }
      : get(id);
    await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(m.writes.map((w) => w.id)).toEqual(["work-f1"]);
    expect(poolLines()).toEqual([]);
    expect(existsSync(join(den, ".memory", "pool", "discarded.jsonl"))).toBe(false);
  });

  it("an archived item's observations are discarded and logged", async () => {
    poolWith([o(0, { work: "work-arch" })]);
    const m = mocks();
    const get = m.workStore.get;
    m.workStore.get = async (id: string) => (id === "work-arch" ? { id, title: "A", kind: "task", stage: "archived", body: "" } : get(id));
    await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(poolLines()).toEqual([]);
    expect(m.prompts.consolidate).toEqual([]);
    expect(readFileSync(join(den, ".memory", "pool", "discarded.jsonl"), "utf-8")).toContain('"reason":"archived"');
  });

  it("with no Work API, or one that is down, tagged observations stay pending and never reach the den", async () => {
    poolWith([o(0, { work: "work-t1" }), o(1), o(2), o(3), o(4), o(5)]);
    const m = mocks();
    const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, minObservations: 1 });
    expect(r.observationsPending).toBe(1);
    expect(poolLines().map((l) => l.content)).toEqual(["observation 0"]);
    expect(m.prompts.consolidate.join("\n")).not.toContain("observation 0");

    const down = mocks();
    down.workStore.get = async () => { throw new Error("ECONNREFUSED"); };
    const r2 = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: down.engine, workStore: down.workStore, minObservations: 1 });
    expect(r2.observationsPending).toBe(1);
    expect(poolLines().map((l) => l.content)).toEqual(["observation 0"]);
    expect(existsSync(join(den, ".memory", "pool", "discarded.jsonl"))).toBe(false);
  });

  it("tasks of one feature share one Record on the feature; a legacy line with only `work` keeps its item", async () => {
    poolWith([o(1, { work: "work-t1", feature: "work-f1" }), o(2, { work: "work-t2", feature: "work-f1" }), o(3, { work: "work-t9" })]);
    const m = mocks();
    const get = m.workStore.get;
    m.workStore.get = async (id: string) => (id === "work-f1" ? { id, title: "F", kind: "feature", stage: "in_build", body: "" } : get(id));
    const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, skipClaims: true, engine: m.engine, workStore: m.workStore });
    expect(r.recordsWritten).toBe(2);
    expect(m.writes.map((w) => w.id).sort()).toEqual(["work-f1", "work-t9"]);
    expect(m.prompts.record.find((p) => p.includes("observation 1"))).toContain("observation 2");
    expect(poolLines()).toEqual([]);
  });

  describe("session mode (sessionTopics)", () => {
    const sessions = () => join(den, ".memory", "sessions", "durable");
    const sessionEngine = (prompts: string[]) =>
      ({
        call: async (step: string, schema: { parse: (v: unknown) => unknown }, p: { prompt: string }) => {
          if (step === "workRecord") return schema.parse({ decisions: [], changes: ["Added the thing"], findings: [], problems: [] });
          prompts.push(p.prompt);
          return schema.parse({ actions: [{ sessionTopicId: "x", action: "create", reasoning: "r", result: { id: "t", title: "T", summary: "s", body: "b" } }] });
        },
      }) as unknown as Engine;

    it("a tagged observation written to the Record creates no session topics", async () => {
      poolWith([o(1, { work: "work-t1" })]);
      const m = mocks();
      const r = await consolidatePool({ wolfDen: den, wolfName: WOLF, engine: m.engine, workStore: m.workStore, sessionTopics: durableSessionTopics(den), minObservations: 1 });
      expect(r.recordsWritten).toBe(1);
      expect(m.writes.map((w) => w.id)).toEqual(["work-t1"]);
      expect(existsSync(join(den, ".memory", "sessions", "durable"))).toBe(false);
      expect(poolLines()).toEqual([]);
    });

    it("a tagged observation whose item is gone is discarded, never a session topic", async () => {
      poolWith([o(0, { work: "gone" })]);
      const m = mocks();
      const prompts: string[] = [];
      const cfg = { wolfDen: den, wolfName: WOLF, engine: sessionEngine(prompts), workStore: m.workStore, sessionTopics: durableSessionTopics(den), minObservations: 1 };
      await consolidatePool(cfg);
      await consolidatePool(cfg); // second run: still gone, the grace period is over
      expect(prompts).toEqual([]);
      expect(existsSync(sessions())).toBe(false);
      expect(poolLines()).toEqual([]);
      expect(readFileSync(join(den, ".memory", "pool", "discarded.jsonl"), "utf-8")).toContain("observation 0");
    });
  });
});
