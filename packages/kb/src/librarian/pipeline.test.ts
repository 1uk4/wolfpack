import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import { normalizeOutcome, readPipeline, RECEIPT_CAP } from "./pipeline.js";
import { writeLastSweep, readLastSweep } from "../shared/last-sweep.js";
import { writeCurrent } from "./progress.js";

describe("readPipeline", () => {
  let base: string;
  let roots: KbRoots;
  const put = (path: string[], body: string, mtimeSec?: number) => {
    const file = join(base, "ops", ...path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
    if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  };
  const receipt = (wolf: string, topic: string, outcome: string, processed: string, detail: string, mtimeSec?: number) =>
    put(["receipts", wolf, `${topic}-abcd.md`], `---\nfrom: ${wolf}\nden_topic_id: ${topic}\noutcome: ${outcome}\nprocessed: ${processed}\n---\n\n${detail}\n`, mtimeSec);

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-pipe-"));
    roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("normalizes every outcome spelling to one", () => {
    expect(["create", "created", "merge", "merged", "updated", "reject", "rejected", "parked", "unclassified"].map((o) => normalizeOutcome(o))).toEqual([
      "create", "create", "merge", "merge", "merge", "reject", "reject", "parked", "unclassified",
    ]);
    expect(normalizeOutcome("weird")).toBeUndefined();
  });

  it("an empty KB reads as an empty pipeline", () => {
    expect(readPipeline(roots)).toEqual({ lanes: [], receipts: [], parked: [], sweep: {} });
  });

  it("lanes count top-level files only (skips _processed and _bad) and give the oldest age", () => {
    const now = Date.now();
    put(["inbox", "w1", "a.md"], "x", now / 1000 - 100);
    put(["inbox", "w1", "b.md"], "x", now / 1000 - 10);
    put(["inbox", "w1", "_processed", "old.md"], "x");
    put(["inbox", "w1", "_bad", "bad.md"], "x");
    mkdirSync(join(base, "ops", "inbox", "w2"), { recursive: true });
    const { lanes } = readPipeline(roots, now);
    expect(lanes).toEqual([{ wolf: "w1", pending: 2, oldestAgeMs: expect.any(Number) }, { wolf: "w2", pending: 0 }]);
    expect(lanes[0].oldestAgeMs).toBeGreaterThanOrEqual(99_000);
    expect(lanes[0].oldestAgeMs).toBeLessThan(102_000);
  });

  it("receipts: spellings normalized, entry id for create / merge, detail otherwise, newest first", () => {
    receipt("w1", "t-create", "created", "2026-10-01T10:00:00.000Z", "kb-wp-AAAAAAA");
    receipt("w1", "t-merge", "merge", "2026-10-01T11:00:00.000Z", "kb-wp-BBBBBBB");
    receipt("w1", "t-upd", "updated", "2026-10-01T09:00:00.000Z", "kb-wp-CCCCCCC");
    receipt("w2", "t-rej", "reject", "2026-10-01T12:00:00.000Z", "archived-older-than-live: a < b");
    receipt("w2", "t-unc", "unclassified", "2026-10-01T08:00:00.000Z", "pending domain: foo");
    receipt("w2", "t-bogus", "wat", "2026-10-01T13:00:00.000Z", "x");
    const { receipts } = readPipeline(roots);
    expect(receipts.map((r) => [r.denTopicId, r.outcome, r.entryId, r.detail])).toEqual([
      ["t-rej", "reject", undefined, "archived-older-than-live: a < b"],
      ["t-merge", "merge", "kb-wp-BBBBBBB", undefined],
      ["t-create", "create", "kb-wp-AAAAAAA", undefined],
      ["t-upd", "merge", "kb-wp-CCCCCCC", undefined],
      ["t-unc", "unclassified", undefined, "pending domain: foo"],
    ]);
  });

  it(`caps receipts at ${RECEIPT_CAP}, keeping the newest`, () => {
    for (let i = 0; i < RECEIPT_CAP + 10; i++) {
      const sec = 1_800_000_000 + i;
      receipt("w1", `t${String(i).padStart(3, "0")}`, "create", new Date(sec * 1000).toISOString(), `kb-wp-${i}`, sec);
    }
    const { receipts } = readPipeline(roots);
    expect(receipts).toHaveLength(RECEIPT_CAP);
    expect(receipts[0].denTopicId).toBe(`t${String(RECEIPT_CAP + 9).padStart(3, "0")}`);
    expect(receipts.at(-1)!.denTopicId).toBe("t010");
  });

  it("parked items carry the reason from their receipt, without the unpark hint", () => {
    put(["parked", "w1", "stuck.md"], "---\nfrom: w1\nden_topic_id: stuck\n---\n\nbody\n");
    receipt("w1", "stuck", "parked", "2026-10-01T10:00:00.000Z", "failed 3 times: junk. Re-run with: wolfpack-kb unpark w1/stuck.md");
    expect(readPipeline(roots).parked).toEqual([{ wolf: "w1", file: "stuck.md", denTopicId: "stuck", reason: "failed 3 times: junk" }]);
  });

  it("sweep: the item in progress and the persisted last sweep", () => {
    writeCurrent(roots, { from: "w1", denTopicId: "t", startedAt: Date.parse("2026-10-01T10:00:00.000Z"), route: "merge" });
    const last = { startedAt: "2026-10-01T09:00:00.000Z", finishedAt: "2026-10-01T09:01:00.000Z", processed: 1, created: 1, merged: 0, rejected: 0, parked: 0, remaining: 0, durationMs: 60000 };
    writeLastSweep(roots, last);
    expect(readLastSweep(roots)).toEqual(last);
    expect(readPipeline(roots).sweep).toEqual({ current: { from: "w1", denTopicId: "t", startedAt: "2026-10-01T10:00:00.000Z", route: "merge" }, last });
  });

  it("a malformed last-sweep file reads as none", () => {
    mkdirSync(roots.denLocal, { recursive: true });
    writeFileSync(join(roots.denLocal, "sweep-last.json"), "{nope");
    expect(readLastSweep(roots)).toBeNull();
  });
});
