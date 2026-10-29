import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import { tryRecoverAndRender, recoveryPausedNote, badJournalNote, RECOVER_MIN_JOURNAL_AGE_MS } from "./rebuild-recover.js";
import { rebuildJournalFile, rebuildBadJournalFile } from "./rebuild-commit.js";

describe("tryRecoverAndRender quarantine", () => {
  let base: string;
  let roots: KbRoots;
  const journal = () => rebuildJournalFile(roots);
  const counter = () => join(roots.denLocal, ".rebuild-recover-failures");
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-recover-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(roots.denLocal, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A journal whose temp rename can never succeed (target directory does not exist). */
  const failingJournal = (ageMs = RECOVER_MIN_JOURNAL_AGE_MS + 60_000) => {
    const tmp = join(roots.denLocal, "t.tmp");
    writeFileSync(tmp, "x");
    writeFileSync(journal(), JSON.stringify({ version: 3, domain: "wp", at: "x", entries: [], renames: [{ tmp, final: join(base, "no", "such", "f") }] }));
    const t = new Date(Date.now() - ageMs);
    utimesSync(journal(), t, t);
  };
  const run = (hooks = {}) => { const notes: string[] = []; const r = tryRecoverAndRender(roots, (m) => notes.push(m), hooks); return { r, notes }; };

  it("quarantines after 3 failed runs on an old journal, verified gone", () => {
    failingJournal();
    expect(run().r.failed).toMatch(/\(1\/3\)/);
    expect(run().r.failed).toMatch(/\(2\/3\)/);
    const third = run().r;
    expect(third).toMatchObject({ quarantined: true });
    expect(existsSync(journal())).toBe(false);
    expect(existsSync(rebuildBadJournalFile(roots))).toBe(true);
    expect(existsSync(counter())).toBe(false);
  });

  it("a quarantine whose rename throws keeps the counter, reports 'quarantine failed', and status shows the paused state", () => {
    failingJournal();
    const rename = () => { throw new Error("EPERM"); };
    run({ rename }); run({ rename });
    const { r, notes } = run({ rename });
    expect(r.quarantined).toBeUndefined();
    expect(r.failed).toMatch(/quarantine failed: EPERM/);
    expect(existsSync(journal())).toBe(true);
    expect(readFileSync(counter(), "utf-8")).toBe("3");
    expect(notes.at(-1)).toMatch(/could not be quarantined/);
    expect(recoveryPausedNote(roots)).toMatch(/PAUSED.*failed 3 run/);
    // (a rename that claims success without moving the journal is covered in rebuild.test.ts via recoverRebuild)
    // and a working rename finally quarantines it
    expect(run().r.quarantined).toBe(true);
    expect(existsSync(journal())).toBe(false);
  });

  it("if the failure counter cannot be written the count is treated as max and the journal is quarantined at once, even when young", () => {
    failingJournal(1000);
    const r = run({ writeCounter: () => { throw new Error("EROFS"); } }).r;
    expect(r.quarantined).toBe(true);
    expect(existsSync(journal())).toBe(false);
    expect(existsSync(rebuildBadJournalFile(roots))).toBe(true);
  });

  it("a young journal is not quarantined even after 3 failures", () => {
    failingJournal(1000);
    run(); run();
    const r = run();
    expect(r.r.failed).toMatch(/\(3\/3\)/);
    expect(r.notes.at(-1)).toMatch(/10 minutes old/);
    expect(existsSync(journal())).toBe(true);
  });

  it("a stale .bad file does not turn a no-op recovery into 'quarantined' (and no journal means no run is skipped)", () => {
    writeFileSync(rebuildBadJournalFile(roots), "old");
    expect(run().r).toEqual({ n: 0 });
    expect(badJournalNote(roots)).toBeDefined(); // still reported
    // a journal that recovers fine alongside a stale .bad: success, not quarantine
    const tmp = join(roots.denLocal, "ok.tmp");
    writeFileSync(tmp, "[]");
    writeFileSync(journal(), JSON.stringify({ version: 3, domain: "wp", at: "x", entries: [], renames: [{ tmp, final: join(roots.denLocal, "ok.json") }] }));
    const r = run().r;
    expect(r.failed).toBeUndefined();
    expect(r.quarantined).toBeUndefined();
    expect(r.n).toBe(1);
  });

  it("an unreadable journal is quarantined at once and flagged quarantined", () => {
    writeFileSync(journal(), "{ nope");
    const r = run().r;
    expect(r.quarantined).toBe(true);
    expect(r.failed).toMatch(/unreadable/);
  });
});
