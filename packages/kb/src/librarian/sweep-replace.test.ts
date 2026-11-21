import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entriesDir, type KbEvent, type KbRoots } from "../shared/index.js";
import type { Section } from "../schema/knowledge.js";
import { MAX_REPLACEMENTS_PER_SWEEP, notifySplitDue, replaceMisfits } from "./sweep-replace.js";
import type { EntryVector } from "./route.js";

const sec = (id: string, centroid: number[]): Section =>
  ({ id, domain: "d", parent: null, depth: 0, label: id, title: id, centroid, memberCount: 1, childIds: [], summary: "s", summaryHash: "h", dirty: false, memberCountAtLastLabel: 1, created: "2026-10-01", updated: "2026-10-01" }) as unknown as Section;

describe("notifySplitDue hook", () => {
  const sections = [sec("sec-a", [1, 0])];
  it("calls the hook once per domain with the oversize sections, and a throwing hook never fails the caller", async () => {
    const calls: unknown[] = [];
    const msgs: string[] = [];
    notifySplitDue((m) => msgs.push(m), ["sec-a (12)"], (d, s) => void calls.push([d, s]), sections);
    notifySplitDue((m) => msgs.push(m), ["sec-a (12)"], () => { throw new Error("boom"); }, sections);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([["d", [{ id: "sec-a", count: 12 }]]]);
    expect(msgs.filter((m) => m.includes("a rebuild is due"))).toHaveLength(2);
    expect(msgs.some((m) => m.includes("onSplitDue hook failed") && m.includes("boom"))).toBe(true);
  });
});

describe("replaceMisfits", () => {
  let base: string;
  let roots: KbRoots;
  let ledger: KbEvent[];
  const A = [1, 0];
  const B = [0.2, 0.9798];
  const vecs: EntryVector[] = [];
  const writer = {
    patchEntry: (_r: KbRoots, domain: string, id: string, content: string) => writeFileSync(join(entriesDir(roots, domain), `${id}.md`), content),
    appendLedger: (_r: KbRoots, e: KbEvent[]) => void ledger.push(...e),
  };
  const add = (id: string, vector: number[], section = "sec-a", extra = "") => {
    writeFileSync(join(entriesDir(roots, "d"), `${id}.md`), `---\nid: ${id}\ndomain: d\nsection: ${section}\n${extra}---\nbody\n`);
    vecs.push({ entryId: id, canonicalId: id, domain: "d", vector });
  };
  const run = (o: object = {}) => replaceMisfits({ roots, sections: [sec("sec-a", A), sec("sec-b", [0, 1])], domains: ["d"], loadEntryVectors: async () => vecs, writer, ...o });
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
    expect(MAX_REPLACEMENTS_PER_SWEEP).toBe(10);
    expect(moves.map((m) => m.entryId)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09", "e10"]);
    expect(sectionOf("e11")).toBe("sec-a");
  });

  it("does not move when the target beats the current fit by less than the margin", async () => {
    add("marginal", [0.75, 0.6614]); // fit A 0.75, fit B ~0.798: target passes the threshold but the gain is under 0.05
    expect(await run()).toEqual([]);
    expect(sectionOf("marginal")).toBe("sec-a");
  });

  it("skips anchored entries", async () => {
    add("anch", [0.1, 1], "sec-a", "anchor: my-key\n");
    expect(await run()).toEqual([]);
    expect(sectionOf("anch")).toBe("sec-a");
  });

  it("dry run reports the planned move and writes nothing", async () => {
    add("m1", [0.1, 1]);
    const moves = await run({ dryRun: true });
    expect(moves).toHaveLength(1);
    expect(sectionOf("m1")).toBe("sec-a");
    expect(ledger).toEqual([]);
  });
});
