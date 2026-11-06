import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLease, foldSections, readLedger, readSections, writeSections } from "@wolfpack/kb/librarian";
import { hubRoots, contributionsRoot } from "./layout.js";
import { formatRehomeReport, kbRehome } from "./kb-rehome.js";
import { main, parseArgs } from "./cli.js";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const put = (f: string, s: string) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, s);
};
const sec = (id: string, domain: string, parent: string | null, childIds: string[] = [], memberCount = 0) => ({
  id, domain, parent, depth: parent ? 1 : 0, label: id, title: id, centroid: [1, 0], memberCount, childIds, summary: "", summaryHash: "", dirty: false, memberCountAtLastLabel: 0, created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z",
});
const entry = (id: string, domain: string, section: string) => `---\nid: ${id}\ntitle: T ${id}\ndomain: ${domain}\nsection: ${section}\n---\nbody ${id}\n`;

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "kb-rehome-"));
  tmp.push(dataDir);
  const roots = hubRoots(dataDir);
  const ep = (d: string, id: string) => join(roots.kbBase, "domains", d, "entries", `${id}.md`);
  put(ep("wolfpack", "kb-wolfpack-AAAAAAA"), entry("kb-wolfpack-AAAAAAA", "wolfpack", "sec-wolfpack-junk"));
  put(ep("wolfpack", "kb-wolfpack-BBBBBBB"), entry("kb-wolfpack-BBBBBBB", "wolfpack", "sec-wolfpack-good"));
  put(ep("snapjack", "kb-snapjack-CCCCCCC"), entry("kb-snapjack-CCCCCCC", "snapjack", "sec-snapjack-x"));
  put(join(roots.kbBase, "domains.yaml"), "domains:\n  wolfpack:\n    label: Wolfpack\n  snapjack:\n    label: Snapjack\n");
  writeSections(roots, [
    sec("sec-wolfpack-junk", "wolfpack", null, [], 1),
    sec("sec-wolfpack-good", "wolfpack", null, [], 1),
    sec("sec-snapjack-x", "snapjack", null, [], 1),
  ] as never);
  return { dataDir, roots, ep };
}

describe("kb-rehome", () => {
  it("dry run changes nothing", async () => {
    const f = fixture();
    const r = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-wolfpack-good" }], removeSections: ["sec-wolfpack-junk"] });
    expect(r.apply).toBe(false);
    expect(formatRehomeReport(r).join("\n")).toContain("dry run");
    expect(readFileSync(f.ep("wolfpack", "kb-wolfpack-AAAAAAA"), "utf-8")).toContain("section: sec-wolfpack-junk");
    expect(readSections(f.roots).length).toBe(3);
    expect(readLedger(f.roots).length).toBe(0);
  });

  it("apply moves, records events, removes the empty section, re-renders, and a re-run is a no-op move", async () => {
    const f = fixture();
    const opts = { dataDir: f.dataDir, moves: [{ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-wolfpack-good" }], removeSections: ["sec-wolfpack-junk"], apply: true };
    await kbRehome(opts);
    expect(readFileSync(f.ep("wolfpack", "kb-wolfpack-AAAAAAA"), "utf-8")).toContain("section: sec-wolfpack-good");
    const log = readLedger(f.roots);
    expect(log.find((e) => e.t === "entry_placed")).toMatchObject({ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-wolfpack-good", basis: "curator-pinned" });
    expect(log.filter((e) => e.t === "sections_replaced").length).toBe(1);
    const snap = readSections(f.roots);
    expect(snap.map((s) => String(s.id)).sort()).toEqual(["sec-snapjack-x", "sec-wolfpack-good"]);
    expect(snap.find((s) => String(s.id) === "sec-wolfpack-good")?.memberCount).toBe(2);
    expect(snap.find((s) => String(s.id) === "sec-wolfpack-good")?.centroid).toEqual([1, 0]);
    // ledger fold agrees for the domain
    const folded = foldSections(log).filter((s) => String(s.domain) === "wolfpack");
    expect(folded.map((s) => String(s.id))).toEqual(["sec-wolfpack-good"]);
    expect(folded[0]!.memberCount).toBe(2);
    expect(existsSync(join(f.roots.kbBase, "domains", "wolfpack", "_digest.json"))).toBe(true);
    expect(existsSync(join(f.roots.kbBase, "domains", "wolfpack", "INDEX.md"))).toBe(true);
    // lock and lease released: a second run works
    const r2 = await kbRehome({ ...opts, removeSections: [] });
    expect(r2.moves[0]!.changed).toBe(false);
    expect(readLedger(f.roots).filter((e) => e.t === "entry_placed").length).toBe(1);
  });

  it("refuses a target section in another domain or a missing one", async () => {
    const f = fixture();
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [{ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-snapjack-x" }] })).rejects.toThrow(/is in domain snapjack/);
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [{ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-nope" }] })).rejects.toThrow(/does not exist/);
    expect(readFileSync(f.ep("wolfpack", "kb-wolfpack-AAAAAAA"), "utf-8")).toContain("sec-wolfpack-junk");
  });

  it("refuses removing a section that is not empty after the moves", async () => {
    const f = fixture();
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [], removeSections: ["sec-wolfpack-junk"] })).rejects.toThrow(/not empty/);
    expect(readSections(f.roots).length).toBe(3);
  });

  it("refuses while the curator sweep lease is held (dry run and apply)", async () => {
    const f = fixture();
    const lease = acquireLease([contributionsRoot(f.dataDir)], "hub")!;
    try {
      const o = { dataDir: f.dataDir, moves: [{ entryId: "kb-wolfpack-AAAAAAA", sectionId: "sec-wolfpack-good" }] };
      await expect(kbRehome(o)).rejects.toThrow(/sweep lease is held/);
      await expect(kbRehome({ ...o, apply: true })).rejects.toThrow(/sweep lease is held/);
    } finally {
      lease.release();
    }
    expect(readFileSync(f.ep("wolfpack", "kb-wolfpack-AAAAAAA"), "utf-8")).toContain("sec-wolfpack-junk");
  });

  it("CLI parsing and run", async () => {
    expect(() => parseArgs(["kb-rehome", "--data-dir", "/x"])).toThrow(/needs at least one/);
    expect(() => parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "bad"])).toThrow(/entryId/);
    const a = parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "e=s", "--remove-section", "r", "--apply"]);
    expect(a.moves).toEqual([{ entryId: "e", sectionId: "s" }]);
    expect(a.removeSections).toEqual(["r"]);
    expect(a.apply).toBe(true);
    const f = fixture();
    const out: string[] = [];
    await main(["kb-rehome", "--data-dir", f.dataDir, "--move", "kb-wolfpack-AAAAAAA=sec-wolfpack-good"], {}, (m) => out.push(m));
    expect(out.join("\n")).toContain("dry run");
  });
});
