/** `hubd work-import`: ledger dedupe/merge, newer-wins files, dry run, lock refusal, domain validation, backup, idempotence. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { loadWorkState } from "@wolfpack/kb/client";
import { hubRoots } from "./layout.js";
import { main } from "./cli.js";
import { importWork } from "./work-import.js";
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
const snapshot = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

describe("hubd work-import", () => {
  it("dry run reports counts and decisions and writes nothing", () => {
    const r = rig();
    const before = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8");
    const rep = importWork({ ...r.opts, dryRun: true });
    expect(rep.eventsToAppend).toBe(7);
    expect(rep.skippedMalformedLines).toBe(1);
    expect(rep.filesToAdd).toEqual([A]);
    expect(rep.filesToUpdate).toEqual([expect.objectContaining({ id: B, from: "in_build", to: "shipped" })]);
    expect(rep.decisions.map((d) => [d.id, d.decision])).toEqual([[B, "legacy"], [C, "hubd"]]);
    expect(readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8")).toBe(before);
    expect(existsSync(r.H(`${A}.md`))).toBe(false);
    expect(existsSync(join(r.data, "backups"))).toBe(false);
  });

  it("imports: dedupes as a multiset, keeps hubd events, orders by time, newer file wins, hubd-only kept, backup made", () => {
    const r = rig();
    const rep = importWork(r.opts);
    expect(rep.mismatches).toEqual([]);
    const lines = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(8);
    expect(lines.filter((l) => l.type === "work.noted")).toHaveLength(2); // identical legacy events both kept
    const ats = lines.map((l) => l.at as string);
    expect(ats).toEqual([...ats].sort());
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
  });

  it("is idempotent: a re-run adds no events and no files and touches nothing", () => {
    const r = rig();
    importWork(r.opts);
    const ledgerBefore = readFileSync(join(r.data, "ledger", "work-events.jsonl"), "utf8");
    const files = snapshot(join(r.data, "kb"));
    const again = importWork(r.opts);
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
    expect(out.join("\n")).toMatch(/dry run, nothing written[\s\S]*events to append: 7/);
    await expect(main(["work-import", "--data-dir", r.data], process.env, () => {})).rejects.toThrow(/--from-domains/);
  });
});
