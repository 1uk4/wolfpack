import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLease, foldSections, readLedger, readSections, writeSections } from "@wolfpack/kb/librarian";
import { ledgerFile } from "@wolfpack/kb/shared";
import { acquireKbWriterLock } from "./kb-commits.js";
import { hubRoots, contributionsRoot } from "./layout.js";
import { formatRehomeReport, kbRehome, sectionOf, setSection } from "./kb-rehome.js";
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

const A = "kb-wolfpack-AAAAAAA", B = "kb-wolfpack-BBBBBBB", C = "kb-snapjack-CCCCCCC";
const JUNK = "sec-wolfpack-junk", GOOD = "sec-wolfpack-good";
const read = (f: string) => readFileSync(f, "utf-8");

describe("kb-rehome", () => {
  it("dry run changes nothing", async () => {
    const f = fixture();
    const r = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], removeSections: [JUNK] });
    expect(r.apply).toBe(false);
    expect(r.errors).toEqual([]);
    expect(formatRehomeReport(r).join("\n")).toContain("dry run");
    expect(read(f.ep("wolfpack", A))).toContain(`section: ${JUNK}`);
    expect(readSections(f.roots).length).toBe(3);
    expect(readLedger(f.roots).length).toBe(0);
  });

  it("apply moves, records events, removes the empty section, re-renders with content, and a re-run is a no-op", async () => {
    const f = fixture();
    const opts = { dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], removeSections: [JUNK], apply: true };
    await kbRehome(opts);
    expect(read(f.ep("wolfpack", A))).toContain(`section: ${GOOD}`);
    const log = readLedger(f.roots);
    expect(log.find((e) => e.t === "entry_placed")).toMatchObject({ entryId: A, sectionId: GOOD, basis: "curator-pinned" });
    expect(log.filter((e) => e.t === "sections_replaced").length).toBe(1);
    const snap = readSections(f.roots);
    expect(snap.map((s) => String(s.id)).sort()).toEqual(["sec-snapjack-x", GOOD]);
    expect(snap.find((s) => String(s.id) === GOOD)?.memberCount).toBe(2);
    expect(snap.find((s) => String(s.id) === GOOD)?.centroid).toEqual([1, 0]);
    const folded = foldSections(log).filter((s) => String(s.domain) === "wolfpack");
    expect(folded.map((s) => String(s.id))).toEqual([GOOD]);
    expect(folded[0]!.memberCount).toBe(2); // fold snapshot == _sections.json
    const dom = join(f.roots.kbBase, "domains", "wolfpack");
    expect(read(join(dom, "INDEX.md"))).toContain(`T ${A}`);
    expect(read(join(dom, "INDEX.md"))).toContain(`T ${B}`);
    const digest = read(join(dom, "_digest.json"));
    expect(digest).toContain(A);
    expect(digest).toContain(B);
    expect(read(join(dom, "_registry.md"))).toContain(`## ${A}`);
    const r2 = await kbRehome({ ...opts, removeSections: [] });
    expect(r2.moves[0]!.changed).toBe(false);
    expect(readLedger(f.roots).filter((e) => e.t === "entry_placed").length).toBe(1);
  });

  it("refuses a target section in another domain or a missing one (dry run reports, apply throws, nothing written)", async () => {
    const f = fixture();
    const dry = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: "sec-snapjack-x" }] });
    expect(dry.errors.join(" ")).toMatch(/is in domain snapjack/);
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [{ entryId: A, sectionId: "sec-snapjack-x" }] })).rejects.toThrow(/is in domain snapjack/);
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [{ entryId: A, sectionId: "sec-nope" }] })).rejects.toThrow(/does not exist/);
    expect(read(f.ep("wolfpack", A))).toContain(JUNK);
    expect(readLedger(f.roots).length).toBe(0);
  });

  it("refuses removing a section that is not empty after the moves", async () => {
    const f = fixture();
    await expect(kbRehome({ dataDir: f.dataDir, apply: true, moves: [], removeSections: [JUNK] })).rejects.toThrow(/not empty/);
    expect(readSections(f.roots).length).toBe(3);
  });

  it("de-dupes --move by entry and refuses conflicting targets", async () => {
    const f = fixture();
    const same = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }, { entryId: A, sectionId: GOOD }] });
    expect(same.moves.length).toBe(1);
    expect(same.errors).toEqual([]);
    const two = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }, { entryId: A, sectionId: JUNK }] });
    expect(two.errors.join(" ")).toMatch(/two different sections/);
  });

  it("refuses while the curator sweep lease is held (dry run reports it, apply throws)", async () => {
    const f = fixture();
    const lease = acquireLease([contributionsRoot(f.dataDir)], "hub")!;
    try {
      const o = { dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }] };
      expect((await kbRehome(o)).errors.join(" ")).toMatch(/sweep lease is held/);
      await expect(kbRehome({ ...o, apply: true })).rejects.toThrow(/sweep lease is held/);
    } finally {
      lease.release();
    }
    expect(read(f.ep("wolfpack", A))).toContain(JUNK);
  });

  it("apply refuses while the KB writer lock is held (a running hubd), writes nothing, and leaves no lease behind", async () => {
    const f = fixture();
    const lock = acquireKbWriterLock(f.dataDir);
    const o = { dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], apply: true };
    try {
      await expect(kbRehome(o)).rejects.toThrow(/lock|writer/i);
    } finally {
      lock.release();
    }
    expect(read(f.ep("wolfpack", A))).toContain(JUNK);
    expect(readLedger(f.roots).length).toBe(0);
    await kbRehome(o); // the lease was released, so this works
    expect(read(f.ep("wolfpack", A))).toContain(GOOD);
  });

  it("partial failure then re-run: an entry already moved still gets entry_placed, a gone section is a no-op, renders are redone", async () => {
    const f = fixture();
    // an interrupted run patched the file and nothing else
    writeFileSync(f.ep("wolfpack", A), entry(A, "wolfpack", GOOD));
    const opts = { dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], removeSections: [JUNK], apply: true };
    const r = await kbRehome(opts);
    expect(r.moves[0]!.changed).toBe(false);
    const log = readLedger(f.roots);
    expect(log.filter((e) => e.t === "entry_placed").length).toBe(1);
    expect(readSections(f.roots).map((s) => String(s.id))).not.toContain(JUNK);
    // second interrupted state: the section is gone, the renders were lost
    rmSync(join(f.roots.kbBase, "domains", "wolfpack", "INDEX.md"));
    const r2 = await kbRehome(opts);
    expect(r2.alreadyGone).toEqual([JUNK]);
    expect(r2.errors).toEqual([]);
    expect(existsSync(join(f.roots.kbBase, "domains", "wolfpack", "INDEX.md"))).toBe(true);
    expect(readLedger(f.roots).filter((e) => e.t === "entry_placed").length).toBe(1);
  });

  it("section line helpers touch only the frontmatter and keep CRLF", () => {
    const crlf = `---\r\nid: x\r\ndomain: wolfpack\r\nsection: ${JUNK}\r\n---\r\nbody\r\nsection: ${JUNK}\r\n`;
    expect(sectionOf(crlf)).toBe(JUNK);
    const out = setSection(crlf, GOOD);
    expect(out).toBe(crlf.replace(`section: ${JUNK}\r\n---`, `section: ${GOOD}\r\n---`));
    const none = `---\r\nid: x\r\ndomain: wolfpack\r\n---\r\nsection: body\r\n`;
    expect(sectionOf(none)).toBe("");
    const added = setSection(none, GOOD);
    expect(added).toBe(`---\r\nid: x\r\ndomain: wolfpack\r\nsection: ${GOOD}\r\n---\r\nsection: body\r\n`);
    const lf = `---\nid: x\ndomain: wolfpack\n---\nsection: body\n`;
    expect(setSection(lf, GOOD)).toBe(`---\nid: x\ndomain: wolfpack\nsection: ${GOOD}\n---\nsection: body\n`);
    expect(() => setSection("no frontmatter\nsection: a\n", GOOD)).toThrow(/frontmatter/);
  });

  it("parent/child sections: child and move-target refusals, childIds fixed, counts are direct", async () => {
    const f = fixture();
    writeSections(f.roots, [
      sec("sec-wolfpack-root", "wolfpack", null, ["sec-wolfpack-par"], 0),
      sec("sec-wolfpack-par", "wolfpack", "sec-wolfpack-root", ["sec-wolfpack-kid"], 0),
      sec("sec-wolfpack-kid", "wolfpack", "sec-wolfpack-par", [], 1),
      sec(GOOD, "wolfpack", null, [], 1),
      sec("sec-snapjack-x", "snapjack", null, [], 1),
    ] as never);
    writeFileSync(f.ep("wolfpack", A), entry(A, "wolfpack", "sec-wolfpack-kid"));
    const base = { dataDir: f.dataDir, apply: true };
    await expect(kbRehome({ ...base, moves: [{ entryId: A, sectionId: GOOD }], removeSections: ["sec-wolfpack-par"] })).rejects.toThrow(/child sections \(sec-wolfpack-kid\)/);
    await expect(kbRehome({ ...base, moves: [{ entryId: A, sectionId: "sec-wolfpack-kid" }], removeSections: ["sec-wolfpack-kid"] })).rejects.toThrow(/move target/);
    await kbRehome({ ...base, moves: [{ entryId: A, sectionId: GOOD }], removeSections: ["sec-wolfpack-par", "sec-wolfpack-kid"] });
    const snap = readSections(f.roots);
    expect(snap.map((s) => String(s.id)).sort()).toEqual(["sec-snapjack-x", GOOD, "sec-wolfpack-root"]);
    expect(snap.find((s) => String(s.id) === "sec-wolfpack-root")?.childIds).toEqual([]);
    expect(snap.find((s) => String(s.id) === GOOD)?.memberCount).toBe(3 - 1); // A and B directly, nothing from a subtree
  });

  it("two domains with prior ledger events: the other domain is untouched", async () => {
    const f = fixture();
    mkdirSync(dirname(ledgerFile(f.roots)), { recursive: true });
    appendFileSync(ledgerFile(f.roots), JSON.stringify({ id: "cur1", at: "2026-10-01T00:00:00.000Z", t: "entry_written", entryId: C, canonicalId: C, action: "create" }) + "\n");
    const snapBefore = JSON.stringify(readSections(f.roots).filter((s) => String(s.domain) === "snapjack"));
    const entryBefore = read(f.ep("snapjack", C));
    await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], removeSections: [JUNK], apply: true });
    expect(JSON.stringify(readSections(f.roots).filter((s) => String(s.domain) === "snapjack"))).toBe(snapBefore);
    expect(read(f.ep("snapjack", C))).toBe(entryBefore);
    expect(existsSync(join(f.roots.kbBase, "domains", "snapjack", "INDEX.md"))).toBe(false);
    const log = readLedger(f.roots);
    expect(log[0]!.id).toBe("cur1"); // prior events kept, in place
    expect(log.some((e) => e.t === "sections_replaced" && (e as { domain: string }).domain === "snapjack")).toBe(false);
    expect(log.some((e) => e.t === "entry_placed" && (e as { entryId: string }).entryId === C)).toBe(false);
  });

  it("a re-run with only an already-gone --remove-section re-renders that domain (domain from the id)", async () => {
    const f = fixture();
    await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], removeSections: [JUNK], apply: true });
    const dom = join(f.roots.kbBase, "domains", "wolfpack");
    rmSync(join(dom, "INDEX.md"));
    rmSync(join(dom, "_digest.json"));
    const r = await kbRehome({ dataDir: f.dataDir, moves: [], removeSections: [JUNK], apply: true });
    expect(r.alreadyGone).toEqual([JUNK]);
    expect(r.domains).toEqual(["wolfpack"]);
    expect(existsSync(join(dom, "INDEX.md"))).toBe(true);
    expect(existsSync(join(dom, "_digest.json"))).toBe(true);
  });

  it("a moves-only run emits sections_replaced so the fold agrees with _sections.json", async () => {
    const f = fixture();
    await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }], apply: true });
    const log = readLedger(f.roots);
    expect(log.filter((e) => e.t === "sections_replaced").map((e) => (e as { domain: string }).domain)).toEqual(["wolfpack"]);
    const fold = foldSections(log).filter((s) => String(s.domain) === "wolfpack");
    const snap = readSections(f.roots).filter((s) => String(s.domain) === "wolfpack");
    expect(fold.map((s) => [String(s.id), s.memberCount]).sort()).toEqual(snap.map((s) => [String(s.id), s.memberCount]).sort());
    expect(snap.find((s) => String(s.id) === JUNK)?.memberCount).toBe(0);
    expect(snap.find((s) => String(s.id) === GOOD)?.memberCount).toBe(2);
  });

  it("the recount excludes grouped entries (the curator's rule) and the dry run prints before -> after and the ledger-only marker", async () => {
    const f = fixture();
    writeFileSync(f.ep("wolfpack", B), `---\nid: ${B}\ntitle: T ${B}\ndomain: wolfpack\nsection: ${GOOD}\ngroup: grp-aaaaaaa\n---\nx\n`);
    const dry = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }] });
    const good = dry.counts.find((c) => c.id === GOOD)!;
    expect(good.after).toBe(1);
    const lines = formatRehomeReport(dry).join("\n");
    expect(lines).toContain(`memberCount ${GOOD} [wolfpack]: 1 -> 1`);
    expect(lines).toContain(`memberCount ${JUNK} [wolfpack]: 1 -> 0`);
    expect(lines).not.toContain("snapjack"); // untouched domain is not listed
    // already in the target but never placed in the ledger: marked
    writeFileSync(f.ep("wolfpack", A), entry(A, "wolfpack", GOOD));
    const dry2 = await kbRehome({ dataDir: f.dataDir, moves: [{ entryId: A, sectionId: GOOD }] });
    expect(formatRehomeReport(dry2).join("\n")).toContain("already in sec-wolfpack-good (ledger entry_placed)");
  });

  it("sectionOf/setSection handle a bare `section:` and quoted values", () => {
    const bare = `---\nid: x\ndomain: wolfpack\nsection:\ntitle: t\n---\nb\n`;
    expect(sectionOf(bare)).toBe("");
    const out = setSection(bare, GOOD);
    expect(out).toBe(`---\nid: x\ndomain: wolfpack\nsection: ${GOOD}\ntitle: t\n---\nb\n`);
    expect((out.match(/^section:/gm) ?? []).length).toBe(1);
    expect(sectionOf(`---\nsection: "${JUNK}"\n---\n`)).toBe(JUNK);
    expect(sectionOf(`---\nsection: '${JUNK}'\n---\n`)).toBe(JUNK);
    expect(setSection(`---\nsection: "${JUNK}"\n---\n`, GOOD)).toBe(`---\nsection: ${GOOD}\n---\n`);
  });

  it("CLI parsing and run", async () => {
    expect(() => parseArgs(["kb-rehome", "--data-dir", "/x"])).toThrow(/needs at least one/);
    expect(() => parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "bad"])).toThrow(/entryId/);
    expect(() => parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "e=s", "--apply", "--dry-run"])).toThrow(/exclude/);
    const a = parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "e=s", "--remove-section", "r", "--apply"]);
    expect(a.moves).toEqual([{ entryId: "e", sectionId: "s" }]);
    expect(a.removeSections).toEqual(["r"]);
    expect(a.apply).toBe(true);
    expect(parseArgs(["kb-rehome", "--data-dir", "/x", "--move", "e=s", "--dry-run"]).dryRun).toBe(true);
    const f = fixture();
    const out: string[] = [];
    await main(["kb-rehome", "--data-dir", f.dataDir, "--move", `${A}=${GOOD}`, "--dry-run"], {}, (m) => out.push(m));
    expect(out.join("\n")).toContain("dry run");
  });
});
