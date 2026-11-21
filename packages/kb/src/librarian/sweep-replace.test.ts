import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { entriesDir, ev, type KbEvent, type KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { notifySplitDue, replaceMisfits } from "./sweep-replace.js";
import { sweep } from "./sweep.js";
import { writeSections } from "./sections.js";
import type { EntryVector } from "./route.js";

const sec = (id: string, centroid: number[], domain = "d"): Section =>
  ({ id, domain, parent: null, depth: 0, label: id, title: id, centroid, memberCount: 1, childIds: [], summary: "s", summaryHash: "h", dirty: false, memberCountAtLastLabel: 1, created: "2026-10-01", updated: "2026-10-01" }) as unknown as Section;

describe("notifySplitDue", () => {
  it("calls the hook once per domain with that domain's oversize sections", async () => {
    const calls: unknown[] = [];
    const big = [{ id: "sec-a", domain: "d", count: 12 }, { id: "sec-b", domain: "d", count: 15 }, { id: "sec-x", domain: "e", count: 11 }];
    await Promise.all(notifySplitDue(() => {}, big, (d, s) => void calls.push([d, s])));
    expect(calls).toEqual([["d", [{ id: "sec-a", count: 12 }, { id: "sec-b", count: 15 }]], ["e", [{ id: "sec-x", count: 11 }]]]);
  });

  it("logs the 'rebuild is due' line with the threshold given, and a throwing hook is logged, not thrown", async () => {
    const msgs: string[] = [];
    await Promise.all(notifySplitDue((m) => msgs.push(m), [{ id: "sec-a", domain: "d", count: 31 }], () => { throw new Error("boom"); }, 20));
    expect(msgs[0]).toBe("sweep: 1 parent section(s) hold more than 20 direct entries (sec-a (31)); a rebuild is due");
    expect(msgs[1]).toContain("onSplitDue hook failed for d: boom");
  });
});

describe("replaceMisfits", () => {
  let base: string;
  let roots: KbRoots;
  let ledger: KbEvent[];
  const A = [1, 0];
  const vecs: EntryVector[] = [];
  const writer = {
    patchEntry: (_r: KbRoots, domain: string, id: string, content: string) => writeFileSync(join(entriesDir(roots, domain), `${id}.md`), content),
    appendLedger: (_r: KbRoots, e: KbEvent[]) => void ledger.push(...e),
  };
  const add = (id: string, vector: number[], section = "sec-a", extra = "") => {
    writeFileSync(join(entriesDir(roots, "d"), `${id}.md`), `---\nid: ${id}\ndomain: d\nsection: ${section}\n${extra}---\nbody\n`);
    vecs.push({ entryId: id, canonicalId: id, domain: "d", vector });
  };
  const SECTIONS = () => [sec("sec-a", A), sec("sec-b", [0, 1])];
  const run = (o: object = {}) => replaceMisfits({ roots, sections: SECTIONS(), domains: ["d"], loadEntryVectors: async () => vecs, writer, ...o });
  const sectionOf = (id: string) => /^section: (.+)$/m.exec(readFileSync(join(entriesDir(roots, "d"), `${id}.md`), "utf8"))?.[1];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-replace-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(entriesDir(roots, "d"), { recursive: true });
    ledger = [];
    vecs.length = 0;
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("moves a misfit entry to the section that fits and ledgers the move", async () => {
    add("m1", [0.1, 1]);
    const moves = await run();
    expect(moves.map((m) => [m.entryId, m.from, m.to])).toEqual([["m1", "sec-a", "sec-b"]]);
    expect(sectionOf("m1")).toBe("sec-b");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ t: "entry_placed", entryId: "m1", sectionId: "sec-b" });
  });

  it("never moves a well-fit entry", async () => {
    add("ok", [1, 0.1]);
    expect(await run()).toEqual([]);
    expect(sectionOf("ok")).toBe("sec-a");
  });

  it("moves exactly 10 of 15 misfits, the worst fits first", async () => {
    for (let i = 1; i <= 15; i++) add(`e${String(i).padStart(2, "0")}`, [i * 0.01, 1]);
    const moves = await run();
    expect(moves.map((m) => m.entryId)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09", "e10"]);
    expect(sectionOf("e11")).toBe("sec-a");
  });

  it("examines at most 50 candidates: a misfit ranked 51st by badness is never routed", async () => {
    // 50 worse candidates that cannot move (no better section: their own is the best), then one movable one.
    for (let i = 0; i < 50; i++) add(`stuck${String(i).padStart(2, "0")}`, [-1, 0.0001 * i]); // opposite to both centroids' best: routes to sec-b with a tiny fit < threshold
    add("late", [0.5, 1]);
    expect(await run()).toEqual([]);
    expect(sectionOf("late")).toBe("sec-a");
  });

  it("does not move when the target beats the current fit by less than the margin", async () => {
    add("marginal", [0.75, 0.6614]); // fit A 0.75, fit B ~0.798: target passes the threshold but the gain is under 0.05
    expect(await run()).toEqual([]);
    expect(sectionOf("marginal")).toBe("sec-a");
  });

  it("does not move when the target itself fits below the threshold", async () => {
    add("lost", [-1, -0.2]); // best section B fits ~ -0.2: far below 0.78
    expect(await run()).toEqual([]);
    expect(sectionOf("lost")).toBe("sec-a");
  });

  it("does not move when the router answers the entry's own section", async () => {
    add("own", [0.6, 0.4], "sec-a"); // misfit by fit (0.83 > 0.78? no: below once threshold raised) but A is still the best section
    expect(await run({ fitThreshold: 0.9 })).toEqual([]);
    expect(sectionOf("own")).toBe("sec-a");
  });

  it("does not move when the router answers _unplaced (no sections for the domain)", async () => {
    add("x", [0.1, 1]);
    expect(await run({ sections: [sec("sec-a", A), sec("sec-z", [0, 1], "other")].filter((s) => s.id !== "sec-z") })).toEqual([]);
    expect(sectionOf("x")).toBe("sec-a");
  });

  it("skips anchored entries and grouped entries", async () => {
    add("anch", [0.1, 1], "sec-a", "anchor: my-key\n");
    add("grp", [0.1, 1], "sec-a", "group: my-key\n");
    expect(await run()).toEqual([]);
    expect(sectionOf("anch")).toBe("sec-a");
    expect(sectionOf("grp")).toBe("sec-a");
  });

  it("dry run reports the planned move and writes nothing", async () => {
    add("m1", [0.1, 1]);
    const moves = await run({ dryRun: true });
    expect(moves).toHaveLength(1);
    expect(sectionOf("m1")).toBe("sec-a");
    expect(ledger).toEqual([]);
  });

  it("leaves a domain alone for 24h after a rebuild apply (sections_replaced), and works again later", async () => {
    add("m1", [0.1, 1]);
    const rebuilt = ev.sectionsReplaced("d", []);
    const at = Date.parse(rebuilt.at);
    expect(await run({ ledger: [rebuilt], now: () => at + 60 * 60 * 1000 })).toEqual([]);
    expect(await run({ ledger: [rebuilt], now: () => at + 25 * 60 * 60 * 1000 })).toHaveLength(1);
  });
});

describe("sweep wiring: re-placement is a dry run unless switched on", () => {
  let base: string;
  let roots: KbRoots;
  const VEC = [0.5, 0.5, 0];
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      return schema.parse({ title: "New thing", kind: { type: "fact" }, summary: "s", detail: "d", confidence: "high", facets: {}, properties: {}, proposedRelations: [] });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;
  const sectionOf = () => /^section: (.+)$/m.exec(readFileSync(join(entriesDir(roots, "personal"), "old.md"), "utf8"))?.[1];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-replace-sweep-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(join(roots.opsRoot, "inbox", "w1"), { recursive: true });
    mkdirSync(entriesDir(roots, "personal"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: VEC }))));
    writeSections(roots, [sec("sec-personal-aaaaaa", [1, 0, 0], "personal"), sec("sec-personal-bbbbbb", [0, 1, 0], "personal")]);
    writeFileSync(join(entriesDir(roots, "personal"), "old.md"), "---\nid: old\ndomain: personal\nsection: sec-personal-aaaaaa\n---\nbody\n");
    writeFileSync(
      join(roots.opsRoot, "inbox", "w1", "c-abc.md"),
      ["---", "from: w1", "den_topic_id: c", "change: create", "content_hash: sha256:abc", "prev_hash: null", "domain_hint: personal", "submitted: 2026-10-20T01:00:00Z", "---", "", "Something new", ""].join("\n"),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const ctx = (o: object = {}) => ({
    engine, roots,
    loadEntryVectors: async () => [{ entryId: "old", canonicalId: "old", domain: "personal", vector: [0.1, 1, 0] }],
    ...o,
  });

  it("writes nothing by default, and moves the entry when replaceDryRun is false", async () => {
    const msgs: string[] = [];
    await sweep(ctx({ notify: (m: string) => msgs.push(m) }));
    expect(readdirSync(entriesDir(roots, "personal")).length).toBeGreaterThan(1); // the new entry was created
    expect(sectionOf()).toBe("sec-personal-aaaaaa");
    expect(msgs.some((m) => m.includes("would re-place old"))).toBe(true);
  });

  it("moves the entry when replaceDryRun is false", async () => {
    await sweep(ctx({ replaceDryRun: false }));
    expect(sectionOf()).toBe("sec-personal-bbbbbb");
  });
});
