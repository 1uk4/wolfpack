/** `hubd work-import`: ledger dedupe/merge, newer-wins files, dry run, lock refusal, domain validation, backup, idempotence. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { loadWorkState } from "@wolfpack/kb/client";
import { hubRoots } from "./layout.js";
import { main } from "./cli.js";
import { importWork, SEED_BY } from "./work-import.js";
import { listWorkItems } from "./work-reads.js";
import { applyOps } from "./work-writes.js";

const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });

const A = "work-wolfpack-AAAAAAA"; // legacy only
const B = "work-wolfpack-BBBBBBB"; // both, legacy newer
const C = "work-wolfpack-CCCCCCC"; // both, hubd newer
const E = "work-wolfpack-EEEEEEE"; // hubd only
const created = (id: string, at: string, extra: object = {}) => ({ type: "work.created", id, at, kind: "task", domain: "wolfpack", title: `t ${id}`, assignee: "1uk4", stage: "plan", ...extra });
const staged = (id: string, at: string, to: string) => ({ type: "work.staged", id, at, to });
const md = (id: string, stage: string, updated: string, body = "") =>
  `---\nid: ${id}\nnodeType: work\nkind: task\ndomain: wolfpack\ntitle: "t ${id}"\nstage: ${stage}\nassignee: 1uk4\ncreated: 2026-10-01\nupdated: ${updated}\n---\n\n# t ${id}\n\n${body}\n`;
const jl = (evs: object[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "hubd-wi-"));
  tmp.push(root);
  const from = join(root, "legacy", "domains");
  const ledger = join(root, "legacy-ledger.jsonl");
  const data = join(root, "data");
  mkdirSync(join(from, "wolfpack", "work"), { recursive: true });
  mkdirSync(join(data, "ledger"), { recursive: true });
  mkdirSync(join(data, "kb", "base", "domains", "wolfpack", "work"), { recursive: true });
  const L = (n: string) => join(from, "wolfpack", "work", n);
  const H = (n: string) => join(data, "kb", "base", "domains", "wolfpack", "work", n);
  writeFileSync(ledger, jl([created(A, "2026-10-02 10:00"), created(B, "2026-10-02 10:01"), staged(B, "2026-11-01 09:00", "shipped"), created(C, "2026-10-02 10:02"), staged(A, "2026-10-03 10:00", "plan"), { type: "work.noted", id: A, at: "2026-10-04 10:00", text: "same" }, { type: "work.noted", id: A, at: "2026-10-04 10:00", text: "same" }]) + "not json\n");
  writeFileSync(L(`${A}.md`), md(A, "plan", "2026-10-04"));
  writeFileSync(L(`${B}.md`), md(B, "shipped", "2026-11-01"));
  writeFileSync(L(`${C}.md`), md(C, "plan", "2026-10-02"));
  writeFileSync(H(`${B}.md`), md(B, "in_build", "2026-10-20"));
  writeFileSync(H(`${C}.md`), md(C, "in_build", "2026-10-30"));
  writeFileSync(H(`${E}.md`), md(E, "plan", "2026-10-30"));
  writeFileSync(join(data, "ledger", "work-events.jsonl"), jl([created("work-wolfpack-DDDDDDD", "2026-11-02 03:00", { by: "hal2" })]));
  const opts = { fromDomains: from, fromLedger: ledger, dataDir: data };
  return { root, from, ledger, data, L, H, opts };
}
const quiet = { warn: () => {} };
const snapshot = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

describe("hubd work-import", () => {
  it("dry run reports counts and decisions and writes nothing", () => {
    const r = rig();
    const before = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8");
    const rep = importWork({ ...r.opts, dryRun: true, ...quiet });
    expect(rep.eventsToAppend).toBe(5); // 7 legacy events: one exact duplicate note and the no-op `staged A plan` collapsed
    expect(rep.dedupe.dropped).toMatchObject({ exact: 1, "noop-stage": 1 });
    expect(rep.seedItems).toEqual({ wolfpack: 1 }); // E: a hubd-only file the ledger never mentions
    expect(rep.eventsOutOfScope).toBe(0);
    expect(rep.skippedMalformedLines).toBe(1);
    expect(rep.filesToAdd).toEqual([A]);
    expect(rep.filesToUpdate).toEqual([expect.objectContaining({ id: B, from: "in_build", to: "shipped" })]);
    expect(rep.decisions.map((d) => [d.id, d.decision])).toEqual([[B, "legacy"], [C, "hubd"]]);
    expect(readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8")).toBe(before);
    expect(existsSync(r.H(`${A}.md`))).toBe(false);
    // the only thing a dry run writes: the list of dropped duplicates (no backup dir, no ledger/file change)
    expect(readdirSync(join(r.data, "backups"))).toEqual([expect.stringMatching(/^work-import-dryrun-.*-dropped\.tsv$/)]);
    expect(readFileSync(rep.dedupe.file!, "utf8")).toMatch(/^noop-stage\t.*\nexact\t/);
  });

  it("imports: dedupes as a multiset, keeps hubd events, orders by time, newer file wins, hubd-only kept, backup made", () => {
    const r = rig();
    const rep = importWork({ ...r.opts, ...quiet });
    // C: hubd's kept file (in_build) is ahead of the legacy ledger (plan): the check reports it, nothing else
    expect(rep.mismatches).toEqual([`${C}: stage ledger "plan" vs file "in_build"`]);
    const lines = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(8); // 1 hubd + 5 legacy (2 duplicates dropped) + 2 seed (E created + same-stage restamp to its updated day)
    expect(lines.filter((l) => l.type === "work.noted")).toHaveLength(1); // the identical legacy note was written twice: one kept
    // each source keeps its own order: legacy created C (10-02) stays AFTER legacy staged B (11-01); hubd's D sits after the older legacy events
    const idx = (f: (l: { type: string; id: string }) => boolean) => lines.findIndex(f);
    expect(idx((l) => l.type === "work.staged" && l.id === B)).toBeLessThan(idx((l) => l.type === "work.created" && l.id === C));
    expect(idx((l) => l.type === "work.created" && l.id === C)).toBeLessThan(idx((l) => l.id === "work-wolfpack-DDDDDDD"));
    expect(lines.filter((l) => l.by === SEED_BY).map((l) => l.id)).toEqual([E, E]);
    expect(lines.some((l) => l.by === "hal2")).toBe(true);
    expect(readFileSync(r.H(`${B}.md`), "utf8")).toContain("stage: shipped");
    expect(readFileSync(r.H(`${C}.md`), "utf8")).toContain("stage: in_build");
    expect(existsSync(r.H(`${E}.md`))).toBe(true);
    expect(existsSync(r.H(`${A}.md`))).toBe(true);
    const bk = rep.backupDir!;
    expect(readFileSync(join(bk, "kb", "base", "domains", "wolfpack", "work", `${B}.md`), "utf8")).toContain("stage: in_build");
    expect(readFileSync(join(bk, "ledger", "work-events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    // the ledger-only write path now knows legacy items
    const roots = hubRoots(r.data);
    expect(loadWorkState(roots).has(A as never)).toBe(true);
    expect(applyOps(roots, A, [{ op: "note", text: "hello" }]).id).toBe(A); // was a 404 for a KB-only item
    expect(applyOps(roots, E, [{ op: "note", text: "hello" }]).id).toBe(E); // and for a hubd-only file (seeded)
  });

  it("is idempotent: a re-run adds no events and no files and touches nothing", () => {
    const r = rig();
    importWork(r.opts);
    const ledgerBefore = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8");
    const files = snapshot(join(r.data, "kb"));
    const again = importWork({ ...r.opts, ...quiet });
    expect(again.seedEvents).toBe(0);
    expect([again.eventsToAppend, again.filesToAdd.length, again.filesToUpdate.length]).toEqual([0, 0, 0]);
    expect(again.backupDir).toBeUndefined();
    expect(readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8")).toBe(ledgerBefore);
    expect(snapshot(join(r.data, "kb"))).toEqual(files);
    expect(readdirSync(join(r.data, "backups"))).toHaveLength(1);
  });

  it("catch-up: only the new legacy events are appended on a later run", () => {
    const r = rig();
    importWork(r.opts);
    writeFileSync(r.ledger, readFileSync(r.ledger, "utf8") + jl([staged(A, "2026-11-03 08:00", "shipped")]));
    const rep = importWork(r.opts);
    expect(rep.eventsToAppend).toBe(1);
    expect(loadWorkState(hubRoots(r.data)).get(A as never)?.stage).toBe("shipped");
  });

  it("refuses while the work-writer lock is held", () => {
    const r = rig();
    const lock = acquireWorkWriterLock(r.data);
    try {
      expect(() => importWork({ ...r.opts, dryRun: true })).toThrow(/stop hubd/);
      expect(() => importWork(r.opts)).toThrow(/stop hubd/);
    } finally { lock.release(); }
    expect(existsSync(join(r.data, "backups"))).toBe(false);
  });

  it("validates --domains and never modifies the sources", () => {
    const r = rig();
    for (const bad of ["../x", "A", "a/b", ".", ""]) expect(() => importWork({ ...r.opts, domains: [bad] })).toThrow(/invalid domain|empty/);
    const src = readFileSync(r.ledger, "utf8");
    importWork(r.opts);
    expect(readFileSync(r.ledger, "utf8")).toBe(src);
    expect(readFileSync(r.L(`${B}.md`), "utf8")).toContain("stage: shipped");
  });

  it("CLI: parses flags and prints the report", async () => {
    const r = rig();
    const out: string[] = [];
    await main(["work-import", "--from-domains", r.from, "--from-ledger", r.ledger, "--data-dir", r.data, "--dry-run", "--domains", "wolfpack"], process.env, (m) => out.push(m));
    expect(out.join("\n")).toMatch(/dry run, nothing written[\s\S]*events to append: 5/);
    await expect(main(["work-import", "--data-dir", r.data], process.env, () => {})).rejects.toThrow(/--from-domains/);
  });

  it("merge order: non-monotonic `at` keeps each source's order; unusable `at` lines ride with their predecessor", () => {
    const r = rig();
    writeFileSync(r.ledger, jl([
      created(A, "2026-10-02 10:00"),
      staged(A, "2026-10-09 10:00", "idea"),
      { type: "work.noted", id: A, at: "2026-10-03 10:00", text: "goes back in time" },
      { type: "work.noted", id: A, at: "", text: "empty at" },
      { type: "work.noted", id: A, at: "garbage", text: "bad at" },
    ]));
    const D = "work-wolfpack-DDDDDDD";
    // hubd's own ledger: a garbage line (kept verbatim, in place) between two events
    writeFileSync(join(r.data, "ledger", "work-events.jsonl"), jl([created(D, "2026-10-05 00:00")]) + "garbage line\n" + jl([{ type: "work.noted", id: D, at: "2026-10-05 00:01", text: "d" }]));
    const rep = importWork({ ...r.opts, ...quiet });
    expect(rep.skippedMalformedLines).toBe(2); // empty and non-date `at` would throw in foldWork: not imported
    const raw = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8").trim().split("\n");
    expect(raw.filter((l) => l === "garbage line")).toHaveLength(1);
    const rows = raw.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.id === A && x.by !== SEED_BY).map((x) => x.type + ":" + (x.text ?? x.to ?? ""))).toEqual(["work.created:", "work.staged:idea", "work.noted:goes back in time"]);
    const pos = (f: (x: { type: string; id: string }) => boolean) => rows.findIndex(f);
    expect(pos((x) => x.id === A && x.type === "work.created")).toBeLessThan(pos((x) => x.id === D && x.type === "work.created"));
    expect(pos((x) => x.id === D && x.type === "work.created")).toBeLessThan(pos((x) => x.id === A && x.type === "work.staged"));
    // the garbage line sits between D's two events
    const iG = raw.indexOf("garbage line");
    expect(JSON.parse(raw[iG - 1]!).id).toBe(D);
    expect(JSON.parse(raw[iG + 1]!).text).toBe("d");
    expect(loadWorkState(hubRoots(r.data)).get(A as never)?.stage).toBe("idea");
  });

  it("seed: malformed files are skipped with a warning and counted; an unreadable file is an error; ids already in the ledger are never seeded", () => {
    const r = rig();
    writeFileSync(r.H("work-wolfpack-FFFFFFF.md"), "not a work file");
    writeFileSync(r.H("work-wolfpack-GGGGGGG.md"), md("work-wolfpack-GGGGGGG", "bogus-stage", "2026-10-02"));
    // a deleted item whose file is still around must not come back
    writeFileSync(r.H("work-wolfpack-HHHHHHH.md"), md("work-wolfpack-HHHHHHH", "plan", "2026-10-02"));
    writeFileSync(join(r.data, "ledger", "work-events.jsonl"), jl([created("work-wolfpack-HHHHHHH", "2026-10-02 10:00"), { type: "work.deleted", id: "work-wolfpack-HHHHHHH", at: "2026-10-03 10:00" }]));
    const warns: string[] = [];
    const rep = importWork({ ...r.opts, warn: (m) => warns.push(m) });
    expect(rep.seedItems).toEqual({ wolfpack: 1 }); // only E
    expect(rep.seedSkipped.sort()).toEqual(["wolfpack/work-wolfpack-FFFFFFF.md", "wolfpack/work-wolfpack-GGGGGGG.md"]);
    expect(warns.length).toBeGreaterThanOrEqual(2);
    expect(listWorkItems(hubRoots(r.data), "wolfpack", true).items.map((i) => i.id)).not.toContain("work-wolfpack-HHHHHHH");
    if (process.getuid?.() !== 0) {
      chmodSync(r.H(`${E}.md`), 0o000);
      try {
        expect(() => importWork({ ...r.opts, dryRun: true, ...quiet })).toThrow(/EACCES/);
      } finally { chmodSync(r.H(`${E}.md`), 0o644); }
    }
  });

  it("seed leaves what the list shows unchanged (same items, stages, parents, titles, updated)", () => {
    const r = rig();
    // hubd-only files with links, a parent and a graduated date
    const P = "work-wolfpack-PPPPPPP", Q = "work-wolfpack-QQQQQQQ";
    writeFileSync(r.H(`${P}.md`), md(P, "in_build", "2026-10-09").replace("stage: in_build", "stage: in_build\ndependsOn:\n  - " + E));
    writeFileSync(r.H(`${Q}.md`), md(Q, "archived", "2026-10-20").replace("assignee: 1uk4", "assignee: 1uk4\npartOf: " + P + "\ngraduated: 2026-10-20"));
    const list = () => listWorkItems(hubRoots(r.data), "wolfpack", true).items.filter((i) => [E, P, Q].includes(i.id));
    const before = list();
    expect(before).toHaveLength(3);
    const rep = importWork({ ...r.opts, ...quiet });
    expect(rep.seedItems.wolfpack).toBe(3);
    expect(rep.mismatches.filter((m) => !m.startsWith(C))).toEqual([]); // C: the kept hubd file is ahead of the legacy ledger (reported, by design)
    expect(list()).toEqual(before);
    const fold = loadWorkState(hubRoots(r.data));
    expect(fold.get(Q as never)).toMatchObject({ stage: "archived", partOf: P, graduated: "2026-10-20", updated: "2026-10-20" });
    expect(fold.get(P as never)?.dependsOn).toEqual([E]);
  });

  it("counts legacy events of other domains as out of scope and binds are reported", () => {
    const r = rig();
    writeFileSync(r.ledger, readFileSync(r.ledger, "utf8") + jl([{ ...created("work-snapjack-SSSSSSS", "2026-10-02 10:00"), domain: "snapjack" }, { type: "work.bound", id: A, at: "2026-10-05 10:00", wolf: "old-hal" }]));
    const rep = importWork({ ...r.opts, dryRun: true, ...quiet });
    expect(rep.eventsOutOfScope).toBe(1);
    expect(rep.bound).toEqual({ "old-hal": 1 });
  });

  it("ledger cache: a repeated read is served from the cache and any append or rewrite invalidates it", () => {
    const r = rig();
    const roots = hubRoots(r.data);
    importWork({ ...r.opts, ...quiet });
    expect(loadWorkState(roots).get(A as never)?.stage).toBe("plan");
    applyOps(roots, A, [{ op: "note", text: "n1" }]);
    expect(loadWorkState(roots).get(A as never)?.log.some((l) => l.text === "n1")).toBe(true);
    writeFileSync(r.ledger, readFileSync(r.ledger, "utf8") + jl([staged(A, "2026-11-03 08:00", "shipped")]));
    importWork({ ...r.opts, ...quiet }); // atomic rewrite: new inode
    expect(loadWorkState(roots).get(A as never)?.stage).toBe("shipped");
  });

  describe("migration-duplicate collapse", () => {
    const withLegacy = (evs: object[]) => { const r = rig(); writeFileSync(r.ledger, jl([created(A, "2026-10-02 10:00"), ...evs])); return r; };
    const run = (r: ReturnType<typeof rig>) => importWork({ ...r.opts, ...quiet });
    const imported = (r: ReturnType<typeof rig>) => readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.id === A);

    it("exact: identical events collapse to one (staged is exempt from this rule)", () => {
      const r = withLegacy([{ type: "work.linked", id: A, at: "2026-10-03 10:00", rel: "depends_on", target: B }, { type: "work.noted", id: A, at: "2026-10-03 10:01", text: "x" }, { type: "work.linked", id: A, at: "2026-10-03 10:00", rel: "depends_on", target: B }]);
      const rep = run(r);
      expect(rep.dedupe.dropped).toMatchObject({ exact: 1 });
      expect(imported(r).map((x) => x.type)).toEqual(["work.created", "work.linked", "work.noted"]);
    });

    it("note: the same id+text collapses to the FIRST occurrence even when `at` differs; different text is kept", () => {
      const r = withLegacy([{ type: "work.noted", id: A, at: "2026-10-03 10:00", text: "same" }, { type: "work.noted", id: A, at: "2026-10-04 10:00", text: "other" }, { type: "work.noted", id: A, at: "2026-10-05 10:00", text: "same" }]);
      const rep = run(r);
      expect(rep.dedupe.dropped.note).toBe(1);
      expect(imported(r).filter((x) => x.type === "work.noted").map((x) => `${x.at}:${x.text}`)).toEqual(["2026-10-03 10:00:same", "2026-10-04 10:00:other"]);
      expect(rep.dedupe.differences).toEqual([]);
    });

    it("adjacent: an event equal (ignoring `at`) to the preceding event of the same item is dropped; a toggle in between keeps it", () => {
      const lk = (at: string) => ({ type: "work.linked", id: A, at, rel: "depends_on", target: B });
      const ul = (at: string) => ({ type: "work.unlinked", id: A, at, rel: "depends_on", target: B });
      const r = withLegacy([lk("2026-10-03 10:00"), lk("2026-10-03 11:00"), ul("2026-10-03 12:00"), lk("2026-10-03 13:00"), { type: "work.retitled", id: A, at: "2026-10-04 10:00", title: "t2" }, { type: "work.retitled", id: A, at: "2026-10-04 11:00", title: "t2" }]);
      const rep = run(r);
      expect(rep.dedupe.dropped.adjacent).toBe(2);
      expect(imported(r).map((x) => x.type)).toEqual(["work.created", "work.linked", "work.unlinked", "work.linked", "work.retitled"]);
      expect(loadWorkState(hubRoots(r.data)).get(A as never)?.dependsOn).toEqual([B]);
    });

    it("stage: only a no-op staged (to the current stage) is dropped; real changes, including back-and-forth, are kept", () => {
      const r = withLegacy([staged(A, "2026-10-03 10:00", "plan"), staged(A, "2026-10-03 11:00", "idea"), staged(A, "2026-10-03 12:00", "plan"), staged(A, "2026-10-03 13:00", "idea"), staged(A, "2026-10-03 13:00", "idea")]);
      const rep = run(r);
      expect(rep.dedupe.dropped["noop-stage"]).toBe(2); // plan->plan at start, and the repeated idea
      expect(imported(r).filter((x) => x.type === "work.staged").map((x) => x.to)).toEqual(["idea", "plan", "idea"]);
      expect(loadWorkState(hubRoots(r.data)).get(A as never)?.stage).toBe("idea");
    });

    it("hubd's own events are never collapsed, and the folded state equals the un-deduped fold", () => {
      const r = withLegacy([{ type: "work.noted", id: A, at: "2026-10-03 10:00", text: "n" }, { type: "work.noted", id: A, at: "2026-10-03 11:00", text: "n" }]);
      const hub = jl([created("work-wolfpack-DDDDDDD", "2026-11-02 03:00"), { type: "work.noted", id: "work-wolfpack-DDDDDDD", at: "2026-11-02 03:01", text: "dup" }, { type: "work.noted", id: "work-wolfpack-DDDDDDD", at: "2026-11-02 03:02", text: "dup" }]);
      writeFileSync(join(r.data, "ledger", "work-events.jsonl"), hub);
      const rep = run(r);
      expect(readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8")).toContain(hub.trim()); // hubd's lines survive verbatim
      expect(rep.dedupe.differences).toEqual([]);
      expect(rep.dedupe.after).toBe(rep.dedupe.before - 1);
    });

    it("idempotent after the collapse: a re-run appends nothing and drops the same copies again", () => {
      const r = withLegacy([{ type: "work.noted", id: A, at: "2026-10-03 10:00", text: "n" }, { type: "work.noted", id: A, at: "2026-10-03 11:00", text: "n" }, staged(A, "2026-10-03 12:00", "plan")]);
      run(r);
      const once = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8");
      const again = run(r);
      expect([again.eventsToAppend, again.dedupe.dropped.note, again.dedupe.dropped["noop-stage"]]).toEqual([0, 1, 1]);
      expect(readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8")).toBe(once);
    });

    it("falls back to keeping an item whole if the collapse would change its folded state", () => {
      // created, deleted, created again with the identical JSON: dropping the second created would leave the item deleted
      const c = created(A, "2026-10-02 10:00");
      const r = rig();
      writeFileSync(r.ledger, jl([c, { type: "work.deleted", id: A, at: "2026-10-03 10:00" }, c]));
      const rep = run(r);
      expect(rep.dedupe.fellBack).toEqual([A]);
      expect(rep.dedupe.dropped.exact).toBe(0);
      expect(loadWorkState(hubRoots(r.data)).has(A as never)).toBe(true);
    });
  });
});
